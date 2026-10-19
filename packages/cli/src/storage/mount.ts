import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DevhostError } from '../errors.js';

/**
 * Where macOS mounts volumes. Overridable so tests never touch the real /Volumes; in that test
 * mode a directory counts as a mount point when it holds a `.test-mounted` file.
 */
export const volumesDir = (): string => process.env['DEVHOST_VOLUMES_DIR'] ?? '/Volumes';
const testMode = (): boolean => process.env['DEVHOST_VOLUMES_DIR'] !== undefined;

export const mountPointFor = (label: string): string => join(volumesDir(), label);

/** Is `dir` a mount point (a different device than its parent)? False when it does not exist. */
export function isMountPoint(dir: string): boolean {
  if (testMode()) return existsSync(join(dir, '.test-mounted'));
  try {
    return statSync(dir).dev !== statSync(resolve(dir, '..')).dev;
  } catch {
    return false;
  }
}

/** The `/Volumes/<name>` a path lies under, or null. */
export function volumeOf(path: string): string | null {
  const base = volumesDir();
  const p = resolve(path);
  if (!p.startsWith(`${base}${sep}`)) return null;
  const name = p.slice(base.length + 1).split(sep)[0];
  return name ? join(base, name) : null;
}

/**
 * Never create anything under /Volumes unless that volume is mounted (spec A13): a path there whose
 * volume is not mounted would otherwise land on the internal disk, in a directory that then hides
 * the volume's own mount point.
 */
export function assertWritable(path: string): void {
  const v = volumeOf(path);
  if (v === null || isMountPoint(v)) return;
  throw new DevhostError(
    `${v} is not mounted: refusing to write ${path} (it would land on the internal disk)`,
    'volume-not-mounted',
    1,
    existsSync(v) ? `${v} exists but is not a mount point: move it aside, then connect (and unlock) the volume.` : 'Connect (and unlock) the work volume, then try again: devhost storage status',
  );
}
