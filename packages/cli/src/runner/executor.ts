import type { ApplyData } from '@devhost/contract';
import { CommandError, HumanActionRequired } from '../errors.js';
import { writeTextWithBackup, readTextIfExists } from '../fsutil.js';
import type { Reporter } from '../reporter.js';
import type { RunOptions, RunResult, Runner } from './types.js';

export type PlanEntry = ApplyData['plan'][number];

export interface ExecOptions extends RunOptions {
  sudo?: boolean;
  /** Shown to the user before a sudo command runs, and in the dry-run plan. */
  reason?: string;
  /** Do not throw on a non-zero exit. */
  allowFailure?: boolean;
}

export interface ExecutorOptions {
  dryRun: boolean;
  verbose: boolean;
  /** Password prompts are possible (stdin is a terminal and output is not JSON). */
  interactiveSudo: boolean;
  now: () => Date;
}

/**
 * Single choke point for side effects (spec A5 "command runner"): logging,
 * dry-run, sudo announcement. Steps read system state with `query()` and change
 * it only with `exec()` / `writeText()`, so a dry-run can never mutate anything.
 */
export class Executor {
  readonly plan: PlanEntry[] = [];
  private stepId = '';

  constructor(
    private readonly runner: Runner,
    private readonly reporter: Reporter,
    private readonly opts: ExecutorOptions,
  ) {}

  get dryRun(): boolean {
    return this.opts.dryRun;
  }

  beginStep(id: string): void {
    this.stepId = id;
  }

  /** Read-only command. Always executes, even in a dry-run. Never throws on non-zero exit. */
  async query(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    this.trace(command, args);
    return this.runner.run(command, args, opts);
  }

  /** Mutating command. In a dry-run it is only recorded in the plan. */
  async exec(command: string, args: string[], opts: ExecOptions = {}): Promise<RunResult> {
    const sudo = opts.sudo === true;
    const line = [sudo ? 'sudo' : null, command, ...args].filter(Boolean).join(' ');
    this.plan.push({ stepId: this.stepId, action: line, sudo, ...(opts.reason ? { reason: opts.reason } : {}) });
    if (this.opts.dryRun) return { code: 0, stdout: '', stderr: '' };

    if (sudo) this.reporter.log('warn', `sudo required: ${opts.reason ?? line}`);
    this.trace(command, args, sudo);
    const result = sudo
      ? await this.runner.run('sudo', [...(this.opts.interactiveSudo ? [] : ['-n']), '--', command, ...args], {
          ...opts,
          interactive: this.opts.interactiveSudo ? true : undefined,
        })
      : await this.runner.run(command, args, opts);

    if (sudo && !this.opts.interactiveSudo && /password is required|terminal is required/i.test(result.stderr)) {
      throw new HumanActionRequired(
        `sudo needs a password for: ${line}`,
        'Run `devhost apply` in a Terminal window on the Mac mini (or over ssh -t) and enter the sudo password there.',
      );
    }
    if (result.code !== 0 && !opts.allowFailure) throw new CommandError(line, result.code, result.stderr);
    return result;
  }

  async readText(path: string): Promise<string | null> {
    return readTextIfExists(path);
  }

  /** Write a file with a timestamped backup of any previous different content (spec A13). */
  async writeText(
    path: string,
    content: string,
    opts: { mode?: number; dirMode?: number; description?: string } = {},
  ): Promise<{ backup: string | null }> {
    this.plan.push({ stepId: this.stepId, action: opts.description ?? `write ${path}`, sudo: false });
    if (this.opts.dryRun) return { backup: null };
    this.trace('write', [path]);
    return writeTextWithBackup(path, content, { now: this.opts.now(), mode: opts.mode, dirMode: opts.dirMode });
  }

  private trace(command: string, args: string[], sudo = false): void {
    if (this.opts.verbose) this.reporter.log('info', `$ ${sudo ? 'sudo ' : ''}${[command, ...args].join(' ')}`);
  }
}
