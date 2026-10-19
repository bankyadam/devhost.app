import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import type { Executor } from '../runner/executor.js';
import { isMountPoint, mountPointFor, volumesDir } from './mount.js';

export type WorkVolume = NonNullable<NonNullable<DevhostConfig['storage']>['workVolume']>;
export const workVolumeOf = (c: DevhostConfig): WorkVolume | null => c.storage?.workVolume ?? null;

/** The file on the volume that names it: its APFS volume UUID (spec A7.12). */
export const MARKER = '.devhost-volume';

type Plist = string | number | boolean | null | Plist[] | { [k: string]: Plist };

/** A small XML property list reader: dict, array, string, integer, real, true/false, data, date. */
export function parsePlist(xml: string): Plist {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const next = (): string => {
    while (i < tokens.length && !tokens[i]!.startsWith('<') && tokens[i]!.trim() === '') i++;
    return tokens[i++] ?? '';
  };
  const text = (close: string): string => {
    let out = '';
    while (i < tokens.length && tokens[i] !== close) out += tokens[i++];
    i++; // the closing tag
    return unescape(out);
  };
  const value = (open: string): Plist => {
    if (open === '<dict>') {
      const o: { [k: string]: Plist } = {};
      for (let t = next(); t !== '</dict>' && t !== ''; t = next()) {
        if (t !== '<key>') continue;
        const k = text('</key>');
        o[k] = value(next());
      }
      return o;
    }
    if (open === '<dict/>') return {};
    if (open === '<array>') {
      const a: Plist[] = [];
      for (let t = next(); t !== '</array>' && t !== ''; t = next()) a.push(value(t));
      return a;
    }
    if (open === '<array/>') return [];
    if (open === '<true/>') return true;
    if (open === '<false/>') return false;
    if (open === '<string/>') return '';
    if (open === '<string>') return text('</string>');
    if (open === '<integer>' || open === '<real>') return Number(text(open.replace('<', '</')));
    if (open === '<data>' || open === '<date>') return text(open.replace('<', '</')).trim();
    if (open === '<plist version="1.0">' || open.startsWith('<plist')) return value(next());
    return null;
  };
  return value(next());
}

const obj = (p: Plist | undefined): { [k: string]: Plist } => (p && typeof p === 'object' && !Array.isArray(p) ? p : {});
const str = (p: Plist | undefined): string => (typeof p === 'string' ? p : '');
const num = (p: Plist | undefined): number => (typeof p === 'number' ? p : 0);

export interface VolumeInfo {
  device: string;
  name: string;
  uuid: string;
  mountPoint: string | null;
  apfs: boolean;
  encrypted: boolean;
  locked: boolean;
  ownership: boolean;
  internal: boolean;
  totalBytes: number;
  freeBytes: number;
}

/** `diskutil info -plist <id>` (a device, a mount point or a volume UUID); null when diskutil does not know it. */
export async function volumeInfo(exec: Executor, id: string): Promise<VolumeInfo | null> {
  const r = await exec.query('diskutil', ['info', '-plist', id]);
  if (r.code !== 0 || !r.stdout.includes('<plist')) return null;
  const d = obj(parsePlist(r.stdout));
  return {
    device: str(d['DeviceIdentifier']),
    name: str(d['VolumeName']),
    uuid: str(d['VolumeUUID']).toUpperCase(),
    mountPoint: str(d['MountPoint']) || null,
    apfs: str(d['FilesystemType']).toLowerCase() === 'apfs',
    encrypted: d['Encryption'] === true || d['FileVault'] === true,
    locked: d['Locked'] === true,
    ownership: d['GlobalPermissionsEnabled'] === true,
    internal: d['Internal'] === true,
    totalBytes: num(d['TotalSize']) || num(d['Size']),
    freeBytes: num(d['APFSContainerFree']) || num(d['FreeSpace']),
  };
}

export interface ExternalDisk {
  device: string;
  model: string;
  sizeBytes: number;
  volumes: { device: string; name: string; uuid: string; mountPoint: string | null; sizeBytes: number }[];
}

/**
 * External physical disks and the APFS volumes on them (`diskutil list -plist external`, whose
 * synthesized APFS containers name their physical store).
 */
export async function listExternal(exec: Executor): Promise<ExternalDisk[]> {
  const r = await exec.query('diskutil', ['list', '-plist', 'external']);
  if (r.code !== 0) return [];
  const all = (obj(parsePlist(r.stdout))['AllDisksAndPartitions'] as Plist[] | undefined) ?? [];
  const disks = new Map<string, ExternalDisk>();
  const wholeOf = (dev: string): string => dev.replace(/s\d+$/, '');
  for (const e of all.map(obj)) {
    const stores = ((e['APFSPhysicalStores'] as Plist[] | undefined) ?? []).map((s) => str(obj(s)['DeviceIdentifier']));
    const owner = stores[0] ? wholeOf(stores[0]) : str(e['DeviceIdentifier']);
    if (!disks.has(owner)) disks.set(owner, { device: owner, model: '', sizeBytes: 0, volumes: [] });
    const disk = disks.get(owner)!;
    if (!stores.length) disk.sizeBytes = num(e['Size']);
    for (const v of ((e['APFSVolumes'] as Plist[] | undefined) ?? []).map(obj)) {
      disk.volumes.push({ device: str(v['DeviceIdentifier']), name: str(v['VolumeName']), uuid: str(v['VolumeUUID']).toUpperCase(), mountPoint: str(v['MountPoint']) || null, sizeBytes: num(v['Size']) });
    }
  }
  for (const d of disks.values()) {
    const r2 = await exec.query('diskutil', ['info', '-plist', d.device]);
    if (r2.code === 0) {
      const info = obj(parsePlist(r2.stdout));
      d.model = str(info['MediaName']) || str(info['IORegistryEntryName']);
      d.sizeBytes = d.sizeBytes || num(info['TotalSize']) || num(info['Size']);
    }
  }
  return [...disks.values()];
}

export interface VolumeStatus {
  label: string;
  uuid: string;
  mountPoint: string;
  /** Mounted at /Volumes/<label>, as the configured volume. */
  mounted: boolean;
  uuidMatch: boolean;
  markerMatch: boolean;
  /** All three: what `storage wait` waits for. */
  ready: boolean;
  /** `/Volumes/<label> 1` exists: macOS mounted it a second time beside a stray directory or volume. */
  doubleMount: boolean;
  /** `/Volumes/<label>` exists but is not a mount point (something wrote there while the volume was away). */
  strayDirectory: boolean;
  apfs: boolean | null;
  encrypted: boolean | null;
  locked: boolean | null;
  ownership: boolean | null;
  totalBytes: number | null;
  freeBytes: number | null;
}

export const readMarker = (mountPoint: string): string | null => {
  try {
    return readFileSync(join(mountPoint, MARKER), 'utf8').trim().toUpperCase();
  } catch {
    return null;
  }
};

/**
 * The configured volume's state. Identity is the APFS volume UUID diskutil reports, the mount
 * point, and the marker file together, never the path alone (spec A7.12).
 */
export async function volumeStatus(exec: Executor, v: WorkVolume): Promise<VolumeStatus> {
  const mountPoint = mountPointFor(v.label);
  const uuid = v.uuid.toUpperCase();
  const info = await volumeInfo(exec, uuid);
  const mounted = isMountPoint(mountPoint) && info?.mountPoint === mountPoint;
  const uuidMatch = info?.uuid === uuid;
  const markerMatch = mounted && readMarker(mountPoint) === uuid;
  let doubleMount = false;
  try {
    doubleMount = readdirSync(volumesDir()).some((n) => n.startsWith(`${v.label} `) && /^ \d+$/.test(n.slice(v.label.length)));
  } catch {
    /* no /Volumes */
  }
  return {
    label: v.label,
    uuid,
    mountPoint,
    mounted,
    uuidMatch,
    markerMatch,
    ready: mounted && uuidMatch && markerMatch,
    doubleMount,
    strayDirectory: existsSync(mountPoint) && !isMountPoint(mountPoint),
    apfs: info ? info.apfs : null,
    encrypted: info ? info.encrypted : null,
    locked: info ? info.locked : null,
    ownership: info ? info.ownership : null,
    totalBytes: info ? info.totalBytes : null,
    freeBytes: info ? info.freeBytes : null,
  };
}

/** Is this path on the work volume (under its mount point)? */
export const onVolume = (v: WorkVolume | null, path: string): boolean => v !== null && (path === mountPointFor(v.label) || path.startsWith(`${mountPointFor(v.label)}/`));
