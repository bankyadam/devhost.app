import type { ApplyData } from '@devhost/contract';
import { mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { CommandError, HumanActionRequired } from '../errors.js';
import { backupFile, isCredentialPath, readTextIfExists, writeTextWithBackup } from '../fsutil.js';
import type { Reporter } from '../reporter.js';
import { PASSWORD_OPERATIONS, helperArgs } from '../root-helper.js';
import { assertWritable } from '../storage/mount.js';
import type { RunOptions, RunResult, Runner } from './types.js';

export type PlanEntry = ApplyData['plan'][number];

export interface ExecOptions extends RunOptions {
  sudo?: boolean;
  /** Shown to the user before a sudo command runs, and in the dry-run plan. */
  reason?: string;
  /** Do not throw on a non-zero exit. */
  allowFailure?: boolean;
  /** Show the command's output as it runs (log events), for commands that take minutes. */
  progress?: boolean;
}

export interface ExecutorOptions {
  dryRun: boolean;
  verbose: boolean;
  /** Password prompts are possible (stdin is a terminal and output is not JSON). */
  interactiveSudo: boolean;
  now: () => Date;
  /** Replaceable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The root helper (root-helper.ts): root commands it can do go through it, without a password, when sudo allows it. */
  rootHelper?: { path: string; launchDaemons: string };
}

/**
 * Single choke point for side effects (spec A5 "command runner"): logging,
 * dry-run, sudo announcement. Steps read system state with `query()` and change
 * it only with `exec()` / `writeText()`, so a dry-run can never mutate anything.
 */
export class Executor {
  readonly plan: PlanEntry[] = [];
  /** Things a human should look at that did not stop the run. */
  readonly warnings: string[] = [];
  private stepId = '';
  private helperUsable?: Promise<boolean>;

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

    const viaHelper = sudo ? await this.helperCall(command, args) : null;
    if (viaHelper) {
      this.trace('sudo', ['-n', '--', ...viaHelper]);
      const result = await this.runner.run('sudo', ['-n', '--', ...viaHelper], opts);
      if (result.code !== 0 && !opts.allowFailure) throw new CommandError(line, result.code, result.stderr);
      return result;
    }
    if (sudo) this.reporter.log('warn', `sudo required: ${opts.reason ?? line}`);
    this.trace(command, args, sudo);
    if (opts.progress) {
      const report = (l: string): void => {
        if (l.trim() !== '') this.reporter.log('info', `  ${l.trimEnd()}`);
      };
      opts = { ...opts, onLine: report };
    }
    const result = sudo
      ? await this.runner.run('sudo', [...(this.opts.interactiveSudo ? [] : ['-n']), '--', command, ...args], {
          ...opts,
          interactive: this.opts.interactiveSudo ? true : undefined,
        })
      : await this.runner.run(command, args, opts);

    if (sudo && !this.opts.interactiveSudo && /password is required|terminal is required/i.test(result.stderr)) {
      throw new HumanActionRequired(
        `sudo needs a password for: ${line}`,
        'Run `devhost apply` in a Terminal window on this host (or over ssh -t) and enter the sudo password there.',
      );
    }
    if (result.code !== 0 && !opts.allowFailure) throw new CommandError(line, result.code, result.stderr);
    return result;
  }

  /**
   * A root operation the helper knows by name (`helper`: its operation and arguments) or, without a
   * usable helper, the equivalent sudo commands (`fallback`). `input` goes to stdin only: a secret
   * there never reaches the plan, a log or an argument list.
   */
  async rootOp(o: { helper: string[]; fallback: { command: string; args: string[]; input?: string }[]; reason: string; input?: string; allowFailure?: boolean }): Promise<RunResult> {
    const h = this.opts.rootHelper;
    if (h) this.helperUsable ??= this.runner.run('sudo', ['-n', '-l', h.path]).then((r) => r.code === 0);
    const viaHelper = h && (await this.helperUsable) ? [h.path, ...o.helper] : null;
    // Secrets and the unlock service: the sudoers rule asks for the password for these (never NOPASSWD).
    if (viaHelper && (PASSWORD_OPERATIONS as readonly string[]).includes(o.helper[0] ?? '')) {
      const line = `sudo ${viaHelper.join(' ')}`;
      this.plan.push({ stepId: this.stepId, action: line, sudo: true, reason: o.reason });
      if (this.opts.dryRun) return { code: 0, stdout: '', stderr: '' };
      if (!this.opts.interactiveSudo) {
        throw new HumanActionRequired(`sudo needs a password for: ${o.reason}`, 'Run this command in a Terminal window on this host (or over ssh -t) and enter the sudo password there.');
      }
      this.reporter.log('warn', `sudo required: ${o.reason}`);
      await this.runner.run('sudo', ['-v'], { interactive: true });
      this.trace('sudo', ['-n', '--', ...viaHelper]);
      const r = await this.runner.run('sudo', ['-n', '--', ...viaHelper], o.input !== undefined ? { input: o.input } : {});
      if (r.code !== 0 && !o.allowFailure) throw new CommandError(line, r.code, r.stderr);
      return r;
    }
    if (viaHelper) {
      const line = `sudo ${viaHelper.join(' ')}`;
      this.plan.push({ stepId: this.stepId, action: line, sudo: true, reason: o.reason });
      if (this.opts.dryRun) return { code: 0, stdout: '', stderr: '' };
      this.trace('sudo', ['-n', '--', ...viaHelper]);
      const r = await this.runner.run('sudo', ['-n', '--', ...viaHelper], o.input !== undefined ? { input: o.input } : {});
      if (r.code !== 0 && !o.allowFailure) throw new CommandError(line, r.code, r.stderr);
      return r;
    }
    let last: RunResult = { code: 0, stdout: '', stderr: '' };
    for (const f of o.fallback) {
      if (f.input === undefined || this.opts.dryRun || !this.opts.interactiveSudo) {
        last = await this.exec(f.command, f.args, { sudo: true, reason: o.reason, ...(f.input !== undefined ? { input: f.input } : {}), ...(o.allowFailure ? { allowFailure: true } : {}) });
        continue;
      }
      // stdin carries the input, so the password is asked first (sudo -v, on the terminal), then the command runs with -n.
      const line = `sudo ${f.command} ${f.args.join(' ')}`;
      this.plan.push({ stepId: this.stepId, action: line, sudo: true, reason: o.reason });
      this.reporter.log('warn', `sudo required: ${o.reason}`);
      await this.runner.run('sudo', ['-v'], { interactive: true });
      last = await this.runner.run('sudo', ['-n', '--', f.command, ...f.args], { input: f.input });
      if (last.code !== 0 && !o.allowFailure) throw new CommandError(line, last.code, last.stderr);
    }
    return last;
  }

  /** The helper call for a root command, when the helper does it and sudo lets this user run it without a password (asked once). */
  private async helperCall(command: string, args: string[]): Promise<string[] | null> {
    const h = this.opts.rootHelper;
    const call = h ? helperArgs(command, args, h.launchDaemons) : null;
    if (!h || !call) return null;
    this.helperUsable ??= this.runner.run('sudo', ['-n', '-l', h.path]).then((r) => r.code === 0);
    return (await this.helperUsable) ? [h.path, ...call] : null;
  }

  warn(message: string): void {
    // A step's check runs again after apply to verify; say each warning once.
    if (this.warnings.includes(message)) return;
    this.warnings.push(message);
    this.reporter.log('warn', message);
  }

  async sleep(ms: number): Promise<void> {
    if (this.opts.dryRun) return;
    await (this.opts.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  }

  /** Poll `probe` until it returns true (a dry-run returns true immediately). */
  async waitFor(probe: () => Promise<boolean>, attempts = 10, delayMs = 1000): Promise<boolean> {
    if (this.opts.dryRun) return true;
    for (let i = 0; i < attempts; i++) {
      if (await probe()) return true;
      await this.sleep(delayMs);
    }
    return false;
  }

  async mkdirp(path: string, opts: { mode?: number } = {}): Promise<void> {
    this.plan.push({ stepId: this.stepId, action: `mkdir -p ${path}`, sudo: false });
    if (this.opts.dryRun) return;
    assertWritable(path);
    await mkdir(path, { recursive: true, mode: opts.mode });
  }

  /** Make `path` a symbolic link to `target` (replacing a link or file that is there). */
  async symlink(target: string, path: string): Promise<void> {
    if ((await readlink(path).catch(() => null)) === target) return;
    this.plan.push({ stepId: this.stepId, action: `ln -sf ${target} ${path}`, sudo: false });
    if (this.opts.dryRun) return;
    assertWritable(path);
    await rm(path, { force: true });
    await symlink(target, path);
  }

  /** Remove a file or directory tree. The caller is responsible for having confirmed it. */
  async remove(path: string, opts: { recursive?: boolean; backup?: boolean } = {}): Promise<void> {
    this.plan.push({ stepId: this.stepId, action: `remove ${path}`, sudo: false });
    if (this.opts.dryRun) return;
    if (opts.backup) {
      const text = await readTextIfExists(path);
      if (text !== null && !isCredentialPath(path)) await backupFile(path, this.opts.now());
    }
    await rm(path, { recursive: opts.recursive === true, force: true });
  }

  async readText(path: string): Promise<string | null> {
    return readTextIfExists(path);
  }

  /** Write a file with a timestamped backup of any previous different content (spec A13). */
  async writeText(
    path: string,
    content: string,
    opts: { mode?: number; dirMode?: number; description?: string; credential?: boolean } = {},
  ): Promise<{ backup: string | null }> {
    this.plan.push({ stepId: this.stepId, action: opts.description ?? `write ${path}`, sudo: false });
    if (this.opts.dryRun) return { backup: null };
    assertWritable(path);
    this.trace('write', [path]);
    return writeTextWithBackup(path, content, { now: this.opts.now(), mode: opts.mode, dirMode: opts.dirMode, credential: opts.credential });
  }

  private trace(command: string, args: string[], sudo = false): void {
    if (this.opts.verbose) this.reporter.log('info', `$ ${sudo ? 'sudo ' : ''}${[command, ...args].join(' ')}`);
  }
}
