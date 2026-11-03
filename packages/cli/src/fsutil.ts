import { mkdir, readFile, readlink, realpath, rename, stat, writeFile, chmod, copyFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export function backupSuffix(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `.devhost-bak-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copy `path` to `<path>.devhost-bak-YYYYMMDD-HHMMSS` (spec A13). Returns the backup path. */
export async function backupFile(path: string, now: Date): Promise<string> {
  let target = `${path}${backupSuffix(now)}`;
  for (let i = 1; await exists(target); i++) target = `${path}${backupSuffix(now)}-${i}`;
  await copyFile(path, target);
  return target;
}

export interface WriteOutcome {
  backup: string | null;
}

/** Files that hold secrets: written 0600 and never backed up (a backup would leave the old secret on disk). */
const CREDENTIAL_NAMES = new Set(['.credentials.json', '.netrc', '.git-credentials', '.env']);
export const isCredentialPath = (path: string): boolean => CREDENTIAL_NAMES.has(basename(path));

/**
 * Atomic write (tmp + rename), creating parent dirs, backing up an existing file that differs.
 * An existing file keeps its mode (never looser than `mode`, when given); a new one gets `mode`,
 * else 0600 for a credential file and 0644 otherwise. A symlink is written through. A credential
 * file (`credential: true`, or by name) gets no backup.
 */
export async function writeTextWithBackup(
  path: string,
  content: string,
  opts: { now: Date; mode?: number; dirMode?: number; credential?: boolean },
): Promise<WriteOutcome> {
  const credential = opts.credential === true || isCredentialPath(path);
  // Replacing a symlink with a regular file would break the link and leave the target stale.
  const target = await realpath(path).catch(async () => {
    const link = await readlink(path).catch(() => null);
    return link === null ? path : resolve(dirname(path), link);
  });
  await mkdir(dirname(target), { recursive: true, mode: opts.dirMode });
  const existing = await stat(target).then((s) => s.mode & 0o777, () => null);
  let mode: number;
  if (existing === null) mode = opts.mode ?? (credential ? 0o600 : 0o644);
  else if (credential) mode = existing & (opts.mode ?? 0o600) & 0o600;
  else mode = opts.mode === undefined ? existing : existing & opts.mode;
  const previous = await readTextIfExists(target);
  let backup: string | null = null;
  if (!credential && previous !== null && previous !== content) backup = await backupFile(target, opts.now);
  const tmp = `${target}.devhost-tmp-${process.pid}`;
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode);
  await rename(tmp, target);
  return { backup };
}
