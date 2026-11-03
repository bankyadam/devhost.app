import { chmod, lstat, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTextWithBackup } from '../src/fsutil.js';

const now = new Date(2026, 9, 12, 20, 30, 15);
const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'fsutil-'));
const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

describe('writeTextWithBackup', () => {
  it('keeps the mode of an existing file', async () => {
    const d = await dir();
    const p = join(d, 'script.sh');
    await writeFile(p, 'old');
    await chmod(p, 0o755);
    await writeTextWithBackup(p, 'new', { now });
    expect(await mode(p)).toBe(0o755);
    await chmod(p, 0o640);
    await writeTextWithBackup(p, 'newer', { now });
    expect(await mode(p)).toBe(0o640);
  });

  it('never makes an existing file looser than the requested mode', async () => {
    const d = await dir();
    const p = join(d, 'config.yaml');
    await writeFile(p, 'old');
    await chmod(p, 0o644);
    await writeTextWithBackup(p, 'new', { now, mode: 0o600 });
    expect(await mode(p)).toBe(0o600);
  });

  it('writes credential files 0600 by default, keeps no backup of them, and tightens a loose one', async () => {
    const d = await dir();
    const p = join(d, '.credentials.json');
    expect((await writeTextWithBackup(p, 'secret-1', { now })).backup).toBeNull();
    expect(await mode(p)).toBe(0o600);
    await chmod(p, 0o644);
    expect((await writeTextWithBackup(p, 'secret-2', { now })).backup).toBeNull();
    expect(await mode(p)).toBe(0o600);
    expect((await readdir(d)).filter((f) => f.includes('devhost-bak'))).toEqual([]);
    const flagged = join(d, 'config.json');
    await writeFile(flagged, 'a');
    expect((await writeTextWithBackup(flagged, 'b', { now, credential: true })).backup).toBeNull();
  });

  it('writes through a symlink and leaves the link in place', async () => {
    const d = await dir();
    const real = join(d, 'real.txt');
    const link = join(d, 'link.txt');
    await writeFile(real, 'old');
    await symlink(real, link);
    await writeTextWithBackup(link, 'new', { now });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('new');
  });
});
