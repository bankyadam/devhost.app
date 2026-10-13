import { spawn } from 'node:child_process';
import type { RunOptions, RunResult, Runner, SpawnedProcess } from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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
      const child = spawn(command, args, {
        env,
        cwd: opts.cwd,
        stdio: opts.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ code: 124, stdout, stderr: `${stderr}timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms\n` });
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('error', (err: NodeJS.ErrnoException) => {
        finish({
          code: err.code === 'ENOENT' ? 127 : 126,
          stdout,
          stderr: err.code === 'ENOENT' ? `command not found: ${command}\n` : `${err.message}\n`,
        });
      });
      child.on('close', (code, signal) => {
        finish({ code: code ?? (signal ? 128 : 1), stdout, stderr });
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
      child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
    return {
      onData: (cb) => void listeners.push(cb),
      write: (data) => void child.stdin.write(data),
      kill: (signal = 'SIGTERM') => void child.kill(signal),
      wait: () => done,
    };
  }
}
