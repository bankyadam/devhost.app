import { join } from 'node:path';
import type { Executor } from './runner/executor.js';
import { whichBinary } from './state.js';

/**
 * mise comes from its own installer (a checksummed prebuilt binary, updated with
 * `mise self-update`), not from Homebrew: Homebrew has no bottles for Intel Macs any more, and
 * building mise there means building llvm and rust first, which takes hours.
 */
export const MISE_INSTALLER_URL = 'https://mise.run';
export const miseInstallPath = (home: string): string => join(home, '.local', 'bin', 'mise');

/**
 * The mise to run: one on PATH (also an older Homebrew install), else the installer's. ssh and
 * launchd have a minimal PATH without ~/.local/bin, so that one is used by its absolute path.
 */
export async function miseBinary(exec: Executor, home: string): Promise<string | null> {
  if (await whichBinary(exec, 'mise')) return 'mise';
  const path = miseInstallPath(home);
  return (await exec.query('test', ['-x', path])).code === 0 ? path : null;
}

/** Install mise with its installer; returns the binary to run. */
export async function installMise(exec: Executor, home: string): Promise<string> {
  const path = miseInstallPath(home);
  await exec.exec('sh', ['-c', `curl -fsSL ${MISE_INSTALLER_URL} | sh`], { env: { MISE_INSTALL_PATH: path }, progress: true });
  return path;
}
