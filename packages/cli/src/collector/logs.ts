import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const DAY = 24 * 3_600_000;
const archive = (path: string, n: number): string => `${path}.${n}.gz`;

/**
 * Service logs (`*.log` in ~/Library/Logs/devhost) kept for `days`: once a day each is copied into
 * `<log>.1.gz` (older ones move up to `.<days>.gz`, the oldest goes) and emptied in place. The
 * services append (`>>`), so they go on writing at the start of the emptied file; a line written
 * between the copy and the truncate is lost. A log nothing wrote to for `days` goes with its archives.
 * `rotatedAt`/`setRotatedAt` remember the last rotation per file name.
 */
export async function rotateLogs(dir: string, now: number, days: number, rotatedAt: (name: string) => number | null, setRotatedAt: (name: string, at: number) => void): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.log')).sort();
  } catch {
    return [];
  }
  const done: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = await stat(path);
    if (now - st.mtimeMs >= days * DAY) {
      await rm(path, { force: true });
      for (let n = 1; n <= days + 1; n++) await rm(archive(path, n), { force: true });
      continue;
    }
    const last = rotatedAt(name);
    if (last !== null && now - last < DAY) continue; // first seen: now
    setRotatedAt(name, now);
    if (st.size === 0) continue;
    await rm(archive(path, days), { force: true });
    for (let n = days - 1; n >= 1; n--) await rename(archive(path, n), archive(path, n + 1)).catch(() => undefined);
    await pipeline(createReadStream(path, { end: st.size - 1 }), createGzip(), createWriteStream(archive(path, 1)));
    await truncate(path, 0);
    done.push(name);
  }
  return done;
}
