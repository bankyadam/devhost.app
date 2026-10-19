import type { Deps } from '../deps.js';
import { UsageError } from '../errors.js';

/**
 * A secret (the work volume passphrase) from stdin, never from an argument: piped in, its first
 * line; at a terminal, typed without echo. It is returned and never written anywhere by this module.
 */
export async function readSecret(deps: Deps, prompt: string): Promise<string> {
  const stdin = deps.stdin as NodeJS.ReadStream;
  if (deps.stdinIsTTY && typeof stdin.setRawMode === 'function') {
    deps.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    try {
      return await new Promise<string>((resolve, reject) => {
        let s = '';
        const onData = (chunk: Buffer | string): void => {
          for (const ch of String(chunk)) {
            if (ch === '\r' || ch === '\n') return done(null);
            if (ch === '\u0003') return done(new UsageError('cancelled'));
            if (ch === '\u007f') s = s.slice(0, -1);
            else s += ch;
          }
        };
        const done = (err: Error | null): void => {
          stdin.off('data', onData);
          deps.stderr.write('\n');
          if (err) reject(err);
          else resolve(s);
        };
        stdin.on('data', onData);
      });
    } finally {
      stdin.setRawMode(false);
      stdin.pause();
    }
  }
  let text = '';
  for await (const chunk of deps.stdin) {
    text += String(chunk);
    if (text.includes('\n')) break;
  }
  const line = text.split(/\r?\n/)[0] ?? '';
  if (line === '') throw new UsageError('no passphrase on stdin', 'Pipe it in (it must not be an argument): printf %s "$PASS" | devhost storage set-passphrase');
  return line;
}
