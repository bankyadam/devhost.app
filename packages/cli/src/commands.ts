import YAML, { stringify } from 'yaml';
import { CONTRACT_VERSION, type ApplyData, type ConfigRawData } from '@devhost/contract';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runSteps } from './apply.js';
import { loadConfig, parseConfig, validateData } from './config/load.js';
import { editConfigFile } from './config/edit.js';
import { missingPortBases } from './ports.js';
import { long, newExecutor, newStepContext, short, type GlobalOptions } from './command-support.js';
import type { DevhostConfig } from '@devhost/contract';
import { getByPointer, parsePointer, parseValue, setByPointer } from './config/pointer.js';
import type { Deps } from './deps.js';
import { ConfigError, DevhostError, UsageError } from './errors.js';
import { backupFile, writeTextWithBackup } from './fsutil.js';
import { runInit, type InitOptions } from './init/init.js';
import { packageJsonPath } from './paths.js';
import { type Executor } from './runner/executor.js';
import { buildSteps, selectSteps } from './steps/index.js';

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

async function readAllStdin(deps: Deps): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of deps.stdin) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Validate the config file, or with --stdin a candidate document (what the desktop app's live validation uses). */
export function configValidateCommand(deps: Deps, g: GlobalOptions, opts: { stdin: boolean } = { stdin: false }): Promise<number> {
  return short(deps, g, async () => {
    if (opts.stdin) parseConfig(await readAllStdin(deps), '<stdin>');
    else await loadConfig(g.configPath);
    return { data: { valid: true, path: opts.stdin ? '<stdin>' : g.configPath }, human: `✅ ${opts.stdin ? 'the document' : g.configPath} is valid` };
  });
}

/** The raw file text (comments included), for editors. */
export function configRawCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<ConfigRawData>(deps, g, async () => {
    const { raw } = await loadConfig(g.configPath);
    return { data: { path: g.configPath, text: raw }, human: raw };
  });
}

/** Replace the whole config with the YAML on stdin, but only if it validates. A backup is kept. */
export function configPutCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short(deps, g, async () => {
    const text = await readAllStdin(deps);
    parseConfig(text, '<stdin>'); // throws ConfigError: nothing is written
    await mkdir(dirname(g.configPath), { recursive: true, mode: 0o700 });
    const { backup } = await writeTextWithBackup(g.configPath, text, { now: deps.now(), mode: 0o600 });
    return {
      data: { pointer: '', value: null, path: g.configPath, backup },
      human: `✅ ${g.configPath} replaced${backup ? ` (backup: ${backup})` : ''}\nChanging config does not apply it: run \`devhost apply\`.`,
    };
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

export function formatApplySummary(data: ApplyData): string[] {
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

/** Allocate missing environment port blocks and persist them (spec A7.9). */
export async function withPortBases(config: DevhostConfig, g: GlobalOptions, deps: Deps, exec: Executor): Promise<DevhostConfig> {
  const missing = missingPortBases(config);
  if (missing.size === 0) return config;
  const envs = config.environments ?? [];
  if (exec.dryRun) {
    const copy = structuredClone(config);
    for (const e of copy.environments ?? []) {
      const base = missing.get(e.name);
      if (base !== undefined) {
        e.portBase = base;
        exec.plan.push({ stepId: `env.${e.name}`, action: `set environments/${e.name}/portBase to ${base} in ${g.configPath}`, sudo: false });
      }
    }
    return copy;
  }
  const { config: updated } = await editConfigFile(g.configPath, deps.now(), (doc) => {
    envs.forEach((e, i) => {
      const base = missing.get(e.name);
      if (base !== undefined) setByPointer(doc, ['environments', String(i), 'portBase'], base);
    });
  });
  return updated;
}

export async function applyCommand(deps: Deps, g: GlobalOptions, opts: ApplyOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const loaded = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, reporter, opts.dryRun);
    const config = await withPortBases(loaded.config, g, deps, exec);
    const steps = selectSteps(buildSteps(config), opts.only);
    const ctx = newStepContext(deps, g, config, exec);
    const outcome = await runSteps(steps, ctx, reporter, deps.cancel);
    return { ok: outcome.error === null, data: outcome.data, error: outcome.error, cancelled: outcome.cancelled, human: formatApplySummary(outcome.data) };
  });
}
