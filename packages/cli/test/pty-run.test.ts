import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { templatesDir } from '../src/paths.js';

const python = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';

/** Runs pty-run.py with Node's own pipes (sockets, which is what broke `script`), typing `input` after a moment. */
function run(args: string[], input?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(python, [join(templatesDir, 'pty-run.py'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    if (input !== undefined) setTimeout(() => child.stdin.write(input), 300);
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('pty-run.py', () => {
  it('gives the command a terminal: it sees one, gets what we type, and its exit code comes back', async () => {
    const r = await run(['sh', '-c', 'test -t 0 && test -t 1 && printf "Trust /x? [y/N] "; read a; echo "got:$a"; exit 3'], 'y\n');
    expect(r.out).toContain('Trust /x? [y/N] ');
    expect(r.out).toContain('got:y');
    expect(r.code).toBe(3);
  });

  it('a command that cannot be started is exit 127 with a message; a signal is 128 + n', async () => {
    const missing = await run(['/no/such/command']);
    expect(missing.code).toBe(127);
    expect(missing.out).toContain('No such file or directory');
    expect((await run(['sh', '-c', 'kill -TERM $$'])).code).toBe(128 + 15);
  });
});
