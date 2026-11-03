import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { RunOptions, RunResult, Runner, SpawnedProcess } from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Commands that stream their output (progress: brew upgrade, rsync of a whole account, a clone) or
 * own the terminal (a login, an editor) take as long as they take; only a plain command that nobody
 * watches gets a default limit.
 */
export function defaultTimeoutMs(opts: RunOptions): number | undefined {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  return opts.interactive || opts.onLine ? undefined : DEFAULT_TIMEOUT_MS;
}

/** Exit code of a process the way a shell reports it: 128 + the signal number (SIGINT is 130). */
const signalExit = (signal: NodeJS.Signals | null): number => (signal ? 128 + (constants.signals[signal] ?? 0) : 1);

/** Calls `onLine` per complete line; `flush` hands over a last line without a newline. */
function lines(onLine: ((line: string) => void) | undefined) {
  let pending = '';
  return {
    push(chunk: string): void {
      if (!onLine) return;
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      parts.forEach((l) => onLine(l));
    },
    flush(): void {
      if (onLine && pending !== '') onLine(pending);
      pending = '';
    },
  };
}

export class RealRunner implements Runner {
  constructor(
    private readonly baseEnv: Record<string, string | undefined>,
    private readonly stdin: Pick<NodeJS.ReadStream, 'readableFlowing' | 'pause' | 'resume'> = process.stdin,
  ) {}

  run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    // An interactive child (sudo's password, claude's questions) owns the terminal. If our own stdin
    // is being read (a prompt asked earlier keeps a readline open), both read the same tty and a
    // typed line goes to whichever reads first: the sudo password got lost. Stop reading meanwhile.
    // Only a stdin that is actually flowing: resuming one nobody reads would start dropping input.
    const pauseStdin = opts.interactive === true && this.stdin.readableFlowing === true;
    if (pauseStdin) this.stdin.pause();
    return new Promise<RunResult>((resolve) => {
      const env = this.childEnv(opts);
      const limit = defaultTimeoutMs(opts);
      // With a limit the child leads its own process group, so the timeout can end what it started too.
      // Without one it stays in ours: a Ctrl-C reaches it as before.
      const grouped = limit !== undefined && !opts.interactive;
      const child = spawn(command, args, {
        env,
        cwd: opts.cwd,
        stdio: opts.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
        detached: grouped,
      });
      const killTree = (signal: NodeJS.Signals): void => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* already gone */
        }
      };

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      const timer = limit === undefined ? undefined : setTimeout(() => {
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 2000).unref();
        finish({ code: 124, stdout, stderr: `${stderr}timed out after ${limit} ms\n` });
      }, limit);

      const out = lines(opts.onLine);
      const err = lines(opts.onLine);
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        stdout += s;
        out.push(s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        stderr += s;
        err.push(s);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        finish({
          code: err.code === 'ENOENT' ? 127 : 126,
          stdout,
          stderr: err.code === 'ENOENT' ? `command not found: ${command}\n` : `${err.message}\n`,
        });
      });
      child.on('close', (code, signal) => {
        out.flush();
        err.flush();
        finish({ code: code ?? signalExit(signal), stdout, stderr });
      });

      if (!opts.interactive && child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(opts.input ?? '');
      }
    }).finally(() => {
      if (pauseStdin) this.stdin.resume();
    });
  }

  private childEnv(opts: RunOptions): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...this.baseEnv, ...opts.env })) {
      if (v !== undefined) env[k] = v;
    }
    for (const k of opts.unsetEnv ?? []) delete env[k];
    return env;
  }

  spawn(command: string, args: string[], opts: RunOptions = {}): SpawnedProcess {
    const child = spawn(command, args, { env: this.childEnv(opts), cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const listeners: ((chunk: string) => void)[] = [];
    const emit = (d: Buffer): void => listeners.forEach((l) => l(d.toString('utf8')));
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.stdin.on('error', () => undefined);
    const done = new Promise<number>((resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ENOENT' ? 127 : 126));
      child.on('close', (code, signal) => resolve(code ?? signalExit(signal)));
    });
    return {
      onData: (cb) => void listeners.push(cb),
      write: (data) => void child.stdin.write(data),
      kill: (signal = 'SIGTERM') => void child.kill(signal),
      wait: () => done,
    };
  }
}

/**
 * What Claude Code sets for the commands its tools run (the session they belong to, its socket,
 * its bridge). Only when they come from a Claude Code session (CLAUDECODE is set); your own
 * CLAUDE_CODE_* settings stay.
 */
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|WORKER_EPOCH|ENVIRONMENT_KIND|BRIDGE_.*|SSE_PORT))$/;

export function withoutClaudeSession(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env['CLAUDECODE'] === undefined) return { ...env };
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.test(k)));
}
