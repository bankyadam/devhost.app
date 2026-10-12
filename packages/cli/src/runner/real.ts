import { spawn } from 'node:child_process';
import type { RunOptions, RunResult, Runner } from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class RealRunner implements Runner {
  constructor(private readonly baseEnv: Record<string, string | undefined>) {}

  run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...this.baseEnv, ...opts.env })) {
        if (v !== undefined) env[k] = v;
      }
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
    });
  }
}
