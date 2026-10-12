import YAML, { stringify } from 'yaml';
import { CONTRACT_VERSION, ExitCode, type ApplyData } from '@devhost/contract';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { runSteps } from './apply.js';
import { loadConfig, validateData } from './config/load.js';
import { getByPointer, parsePointer, parseValue, setByPointer } from './config/pointer.js';
import type { Deps } from './deps.js';
import { ConfigError, DevhostError, UsageError } from './errors.js';
import { backupFile } from './fsutil.js';
import { runInit, type InitOptions } from './init/init.js';
import { writeEnvelope, writeHumanError, writeResultEvent, errorEntries, exitCodeFor } from './output.js';
import { packageJsonPath } from './paths.js';
import { HumanReporter, NdjsonReporter, type Reporter } from './reporter.js';
import { Executor } from './runner/executor.js';
import { allSteps, selectSteps } from './steps/index.js';

export interface GlobalOptions {
  json: boolean;
  verbose: boolean;
  yes: boolean;
  configPath: string;
}

/** A short command: compute data, then print it as an envelope (--json) or as text. */
async function short<T>(
  deps: Deps,
  g: GlobalOptions,
  work: () => Promise<{ data: T; human: string }>,
): Promise<number> {
  try {
    const { data, human } = await work();
    if (g.json) writeEnvelope(deps, true, data);
    else deps.stdout.write(`${human.endsWith('\n') ? human : `${human}\n`}`);
    return ExitCode.Ok;
  } catch (err) {
    if (g.json) writeEnvelope(deps, false, null, errorEntries(err));
    else writeHumanError(deps, err);
    return exitCodeFor(err);
  }
}

export function cliVersion(): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

export function versionCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short(deps, g, async () => {
    const data = {
      cliVersion: cliVersion(),
      contractVersion: CONTRACT_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    };
    return { data, human: `devhost ${data.cliVersion} (contract ${data.contractVersion})` };
  });
}

export function initCommand(deps: Deps, g: GlobalOptions, opts: InitOptions): Promise<number> {
  return short(deps, g, async () => {
    const data = await runInit(g.configPath, { ...opts, nonInteractive: opts.nonInteractive || g.json || g.yes }, deps);
    const human = [
      `✅ ${data.overwritten ? 'Overwrote' : 'Created'} ${data.path}${data.backup ? ` (backup: ${data.backup})` : ''}`,
      '⚠️  The ntfy topic in that file works like a password: anyone who knows it can read your notifications.',
      'Next: review the file, then run `devhost apply --dry-run` and `devhost apply`.',
    ].join('\n');
    return { data, human };
  });
}

export function configGetCommand(deps: Deps, g: GlobalOptions, pointer: string): Promise<number> {
  return short(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const found = getByPointer(config, parsePointer(pointer));
    if (!found.found) throw new UsageError(`nothing at ${pointer}`);
    const human = typeof found.value === 'string' ? found.value : stringify(found.value).trimEnd();
    return { data: { pointer, value: found.value ?? null }, human };
  });
}

export function configValidateCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short(deps, g, async () => {
    await loadConfig(g.configPath);
    return { data: { valid: true, path: g.configPath }, human: `✅ ${g.configPath} is valid` };
  });
}

export function configSetCommand(deps: Deps, g: GlobalOptions, pointer: string, valueText: string): Promise<number> {
  return short(deps, g, async () => {
    const { raw } = await loadConfig(g.configPath);
    const doc = YAML.parseDocument(raw);
    const value = parseValue(valueText);
    setByPointer(doc, parsePointer(pointer), value);
    validateData(doc.toJS(), g.configPath); // throws ConfigError: nothing is written
    const backup = await backupFile(g.configPath, deps.now());
    await writeFile(g.configPath, doc.toString(), { mode: 0o600 });
    return {
      data: { pointer, value: value ?? null, path: g.configPath, backup },
      human: `✅ ${pointer} updated in ${g.configPath}\nChanging config does not apply it: run \`devhost apply\`.`,
    };
  });
}

export function configEditCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short(deps, g, async () => {
    if (g.json || !deps.stdinIsTTY) throw new UsageError('`config edit` needs a terminal', 'Use `devhost config set` instead.');
    const { raw } = await loadConfig(g.configPath);
    const backup = await backupFile(g.configPath, deps.now());
    const editor = deps.env['VISUAL'] ?? deps.env['EDITOR'] ?? 'vi';
    const r = await deps.runner.run(editor, [g.configPath], { interactive: true });
    if (r.code !== 0) throw new DevhostError(`editor exited with code ${r.code}`, 'editor-failed');
    const edited = await readFile(g.configPath, 'utf8');
    try {
      validateConfigText(edited, g.configPath);
    } catch (err) {
      await writeFile(g.configPath, raw, { mode: 0o600 });
      if (err instanceof ConfigError) {
        throw new ConfigError(`${err.message}; your edit was reverted (saved copy: ${backup})`, err.issues);
      }
      throw err;
    }
    return { data: { valid: true, path: g.configPath }, human: `✅ ${g.configPath} saved and valid` };
  });
}

function validateConfigText(text: string, path: string): void {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigError(`${path} is not valid YAML`, doc.errors.map((e) => ({ path: '', message: e.message.split('\n')[0] ?? '' })));
  validateData(doc.toJS(), path);
}

export interface ApplyOptions {
  dryRun: boolean;
  only: string[];
}

function formatHumanSummary(data: ApplyData): string[] {
  const lines: string[] = [];
  if (data.dryRun) {
    lines.push('', data.plan.length === 0 ? 'Dry run: nothing to do.' : 'Dry run plan (nothing was changed):');
    for (const p of data.plan) {
      lines.push(`  ${p.sudo ? '[sudo] ' : ''}${p.stepId}: ${p.action}${p.reason ? `  — ${p.reason}` : ''}`);
    }
  } else {
    lines.push('', data.changed ? 'Done: changes were applied.' : 'No changes: the system already matches the config.');
  }
  return lines;
}

export async function applyCommand(deps: Deps, g: GlobalOptions, opts: ApplyOptions): Promise<number> {
  const reporter: Reporter = g.json
    ? new NdjsonReporter(deps.stdout)
    : new HumanReporter(deps.stdout, deps.stderr, g.verbose);
  try {
    const { config } = await loadConfig(g.configPath);
    const steps = selectSteps(allSteps, opts.only);
    const exec = new Executor(deps.runner, reporter, {
      dryRun: opts.dryRun,
      verbose: g.verbose,
      interactiveSudo: deps.stdinIsTTY && !g.json,
      now: deps.now,
    });
    const outcome = await runSteps(steps, { config, home: deps.home, exec }, reporter, deps.cancel);

    if (outcome.cancelled) {
      const errors = [{ code: 'cancelled', message: 'cancelled after the current step' }];
      if (g.json) writeResultEvent(deps, false, outcome.data, errors);
      else deps.stdout.write('Cancelled after the current step; state is consistent. Re-run `devhost apply` to continue.\n');
      return ExitCode.Cancelled;
    }
    if (outcome.error) {
      const errors = errorEntries(outcome.error);
      if (g.json) writeResultEvent(deps, false, outcome.data, errors);
      else {
        for (const line of formatHumanSummary(outcome.data)) deps.stdout.write(`${line}\n`);
        writeHumanError(deps, outcome.error);
      }
      return exitCodeFor(outcome.error);
    }
    if (g.json) writeResultEvent(deps, true, outcome.data);
    else for (const line of formatHumanSummary(outcome.data)) deps.stdout.write(`${line}\n`);
    return ExitCode.Ok;
  } catch (err) {
    if (g.json) writeResultEvent(deps, false, null, errorEntries(err));
    else writeHumanError(deps, err);
    return exitCodeFor(err);
  }
}
