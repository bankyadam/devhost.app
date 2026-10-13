import { ExitCode, type DevhostConfig } from '@devhost/contract';
import type { Deps } from './deps.js';
import { type DevhostError } from './errors.js';
import { errorEntries, exitCodeFor, writeEnvelope, writeHumanError, writeResultEvent } from './output.js';
import { HumanReporter, NdjsonReporter, type Reporter } from './reporter.js';
import { Executor } from './runner/executor.js';
import type { StepContext } from './steps/types.js';

export interface GlobalOptions {
  json: boolean;
  verbose: boolean;
  yes: boolean;
  configPath: string;
}

/** A short command: compute data, then print it as an envelope (--json) or as text. */
export async function short<T>(
  deps: Deps,
  g: GlobalOptions,
  work: () => Promise<{ data: T; human: string; /** Exit code when the command ran fine but its answer is "not OK" (doctor). */ exit?: number }>,
): Promise<number> {
  try {
    const { data, human, exit } = await work();
    if (g.json) writeEnvelope(deps, exit === undefined || exit === 0, data);
    else deps.stdout.write(`${human.endsWith('\n') ? human : `${human}\n`}`);
    return exit ?? ExitCode.Ok;
  } catch (err) {
    if (g.json) writeEnvelope(deps, false, null, errorEntries(err));
    else writeHumanError(deps, err);
    return exitCodeFor(err);
  }
}

export function newReporter(deps: Deps, g: GlobalOptions): Reporter {
  return g.json ? new NdjsonReporter(deps.stdout) : new HumanReporter(deps.stdout, deps.stderr, g.verbose);
}

export function newExecutor(deps: Deps, g: GlobalOptions, reporter: Reporter, dryRun: boolean): Executor {
  return new Executor(deps.runner, reporter, {
    dryRun,
    verbose: g.verbose,
    interactiveSudo: deps.stdinIsTTY && !g.json,
    now: deps.now,
  });
}

export function newStepContext(deps: Deps, g: GlobalOptions, config: DevhostConfig, exec: Executor, extra: Partial<StepContext> = {}): StepContext {
  return { config, home: deps.home, user: deps.user, brewPrefix: deps.brewPrefix, exec, configPath: g.configPath, ...extra };
}

export interface LongOutcome {
  ok: boolean;
  data: unknown;
  error?: Error | DevhostError | null;
  cancelled?: boolean;
  /** Lines printed after the progress output in human mode. */
  human?: string[];
}

/**
 * A long-running command: progress goes through the reporter (NDJSON events with
 * --json), then one final `result` event or a human summary (spec A9).
 */
export async function long(deps: Deps, g: GlobalOptions, work: (reporter: Reporter) => Promise<LongOutcome>): Promise<number> {
  const reporter = newReporter(deps, g);
  try {
    const o = await work(reporter);
    if (o.cancelled) {
      const errors = [{ code: 'cancelled', message: 'cancelled after the current step' }];
      if (g.json) writeResultEvent(deps, false, o.data, errors);
      else deps.stdout.write('Cancelled after the current step; state is consistent. Re-run the command to continue.\n');
      return ExitCode.Cancelled;
    }
    if (o.error) {
      if (g.json) writeResultEvent(deps, false, o.data, errorEntries(o.error));
      else {
        for (const line of o.human ?? []) deps.stdout.write(`${line}\n`);
        writeHumanError(deps, o.error);
      }
      return exitCodeFor(o.error);
    }
    if (g.json) writeResultEvent(deps, o.ok, o.data);
    else for (const line of o.human ?? []) deps.stdout.write(`${line}\n`);
    return o.ok ? ExitCode.Ok : ExitCode.ChecksFailed;
  } catch (err) {
    if (g.json) writeResultEvent(deps, false, null, errorEntries(err));
    else writeHumanError(deps, err);
    return exitCodeFor(err);
  }
}
