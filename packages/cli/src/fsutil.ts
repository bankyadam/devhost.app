import { mkdir, readFile, rename, stat, writeFile, chmod, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

/** Atomic write (tmp + rename), creating parent dirs, backing up an existing file that differs. */
export async function writeTextWithBackup(
  path: string,
  content: string,
  opts: { now: Date; mode?: number; dirMode?: number },
): Promise<WriteOutcome> {
  await mkdir(dirname(path), { recursive: true, mode: opts.dirMode });
  const previous = await readTextIfExists(path);
  let backup: string | null = null;
  if (previous !== null && previous !== content) backup = await backupFile(path, opts.now);
  const tmp = `${path}.devhost-tmp-${process.pid}`;
  await writeFile(tmp, content, { mode: opts.mode ?? 0o644 });
  if (opts.mode !== undefined) await chmod(tmp, opts.mode);
  await rename(tmp, path);
  return { backup };
}
