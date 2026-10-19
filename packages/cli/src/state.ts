import { join } from 'node:path';
import { devhostConfigDir } from './config/paths.js';
import type { Executor } from './runner/executor.js';

/** Machine facts devhost resolved once (spec A7.5: use absolute paths in every plist). */
export interface DevhostState {
  claudePath?: string;
  colimaPath?: string;
  /** Account roots `storage migrate` moved, by account: the old copy, kept until `--cleanup`. */
  migrated?: Record<string, string>;
}

export const statePath = (home: string): string => join(devhostConfigDir(home), 'state.json');

export async function readState(exec: Executor, home: string): Promise<DevhostState> {
  const text = await exec.readText(statePath(home));
  if (text === null) return {};
  try {
    const data = JSON.parse(text) as unknown;
    return data !== null && typeof data === 'object' ? (data as DevhostState) : {};
  } catch {
    return {};
  }
}

export async function writeState(exec: Executor, home: string, state: DevhostState): Promise<void> {
  await exec.writeText(statePath(home), `${JSON.stringify(state, null, 2)}\n`, { description: `write ${statePath(home)}` });
}

/** Absolute path of a binary on PATH, or null. */
export async function whichBinary(exec: Executor, name: string): Promise<string | null> {
  const r = await exec.query('sh', ['-c', `command -v ${name}`]);
  const path = r.stdout.trim().split('\n')[0] ?? '';
  return r.code === 0 && path.startsWith('/') ? path : null;
}

/** Resolve a tool for use in a plist: recorded path, else PATH lookup, else a sensible default. */
export async function toolPath(exec: Executor, home: string, name: keyof DevhostState & `${string}Path`, binary: string, fallback: string): Promise<string> {
  const state = await readState(exec, home);
  return state[name] ?? (await whichBinary(exec, binary)) ?? fallback;
}
