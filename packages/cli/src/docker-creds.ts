import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Executor } from './runner/executor.js';

/**
 * Docker credential helpers that read the macOS login Keychain. Docker Desktop sets `credsStore:
 * desktop` on every start; without a GUI login (ssh, as the app runs devhost, or a LaunchDaemon)
 * the Keychain cannot be used, and the CLI fails every pull, public images included.
 */
const KEYCHAIN_HELPERS = new Set(['desktop', 'osxkeychain']);

export const isKeychainError = (stderr: string): boolean => /error getting credentials/.test(stderr) && /keychain/i.test(stderr);

/** The Docker config devhost uses then: the user's, without the Keychain helpers. */
export const keychainFreeDir = (home: string): string => join(home, '.local', 'share', 'devhost', 'docker');

/** `config.json` without the Keychain credential helpers; null when it has none (or is not JSON). */
export function withoutKeychain(text: string): string | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  let changed = false;
  if (typeof data['credsStore'] === 'string' && KEYCHAIN_HELPERS.has(data['credsStore'])) {
    delete data['credsStore'];
    changed = true;
  }
  const helpers = data['credHelpers'];
  if (helpers !== null && typeof helpers === 'object' && !Array.isArray(helpers)) {
    const kept = Object.fromEntries(Object.entries(helpers).filter(([, h]) => !(typeof h === 'string' && KEYCHAIN_HELPERS.has(h))));
    if (Object.keys(kept).length !== Object.keys(helpers).length) {
      data['credHelpers'] = kept;
      changed = true;
    }
  }
  return changed ? `${JSON.stringify(data, null, 2)}\n` : null;
}

/**
 * A DOCKER_CONFIG directory like ~/.docker (contexts, CLI plugins, buildx: links to it) whose
 * config.json has no Keychain helper, so public images pull without a GUI login; registries the
 * user logged in to through the Keychain are not available there. Null when there is nothing to
 * leave out.
 */
export async function keychainFreeDockerConfig(exec: Executor, home: string): Promise<string | null> {
  const src = join(home, '.docker');
  const text = await exec.readText(join(src, 'config.json'));
  const config = text === null ? null : withoutKeychain(text);
  if (config === null) return null;
  const dir = keychainFreeDir(home);
  await exec.mkdirp(dir, { mode: 0o700 });
  if ((await exec.readText(join(dir, 'config.json'))) !== config) await exec.writeText(join(dir, 'config.json'), config, { mode: 0o600, credential: true });
  for (const name of await readdir(src).catch(() => [] as string[])) {
    if (name !== 'config.json' && !name.startsWith('config.json.')) await exec.symlink(join(src, name), join(dir, name));
  }
  return dir;
}
