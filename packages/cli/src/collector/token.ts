import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const tokenPath = (home: string): string => join(home, '.local', 'share', 'devhost', 'collector-token');

/**
 * The per-install bearer token of the local collector: created (mode 600) on first use,
 * read afterwards. `apply` puts it in the Claude settings, the collector requires it.
 */
export function collectorToken(home: string): string {
  const path = tokenPath(home);
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/.test(t)) return t;
  } catch {
    /* create below */
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const t = randomBytes(24).toString('hex');
  writeFileSync(path, `${t}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}
