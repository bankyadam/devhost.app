import { join } from 'node:path';
import { devhostConfigDir } from './config/paths.js';

/**
 * The root helper (templates/devhost-root.js): a root-owned script the devhost user may run with
 * sudo and no password. It performs devhost's own root operations and checks each one (services
 * run as the user, nothing user-writable runs as root), so the desktop app and ssh no longer need
 * someone at a keyboard for the sudo password. Installed with `machine.rootHelper: true`.
 */
export const HELPER_PATH = '/Library/PrivilegedHelperTools/app.devhost.root';
export const SUDOERS_PATH = '/etc/sudoers.d/devhost';
export const SYSTEM_LAUNCH_DAEMONS = '/Library/LaunchDaemons';

/** Where the helper and the rule are installed; tests point this at a temporary directory (the rule always names HELPER_PATH). */
const testRoot = (): string | undefined => process.env['DEVHOST_ROOT_HELPER_DIR'];
export const installedHelperPath = (): string => (testRoot() ? join(testRoot()!, 'app.devhost.root') : HELPER_PATH);
export const installedSudoersPath = (): string => (testRoot() ? join(testRoot()!, 'sudoers') : SUDOERS_PATH);

export const stagedHelperPath = (home: string): string => join(devhostConfigDir(home), 'root-helper', 'app.devhost.root');
export const stagedSudoersPath = (home: string): string => join(devhostConfigDir(home), 'root-helper', 'sudoers');

const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const LABEL = /^com\.devhost\.[A-Za-z0-9._-]+$/;

/** Helper operations that always need the sudo password (templates/devhost-root.js): secrets and the unlock service. */
export const PASSWORD_OPERATIONS = ['set-passphrase', 'remove-passphrase', 'unlock-daemon-remove'] as const;

/** The sudoers rule: this one user may run the helper (with any arguments; it checks them) as root, without a password. */
export function sudoersRule(user: string): string {
  if (!USER.test(user) || user === 'root') throw new Error(`"${user}" is not a user name for the sudoers rule`);
  return [
    '# Managed by devhost (machine.rootHelper). The helper checks every operation it is asked for;',
    '# see /Library/PrivilegedHelperTools/app.devhost.root. Remove with machine.rootHelper: false.',
    `Defaults:${user} env_reset`,
    `${user} ALL=(root) NOPASSWD: ${HELPER_PATH}`,
    '# The last matching line wins: these three handle secrets or the unlock service and keep asking for the password.',
    `${user} ALL=(root) PASSWD: ${PASSWORD_OPERATIONS.map((o) => `${HELPER_PATH} ${o}`).join(', ')}`,
    '',
  ].join('\n');
}

const labelOf = (path: string, dir: string): string | null => {
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.plist')) return null;
  const label = path.slice(prefix.length, -'.plist'.length);
  return LABEL.test(label) ? label : null;
};

const systemLabel = (target: string | undefined): string | null => {
  const label = target?.startsWith('system/') ? target.slice('system/'.length) : null;
  return label && LABEL.test(label) ? label : null;
};

/**
 * The helper call for a root command devhost runs, or null when the helper does not do it (those
 * keep asking for the sudo password: installing the helper itself, `brew services` for Tailscale,
 * whose daemon runs as root from a user-writable Homebrew prefix).
 */
export function helperArgs(command: string, args: readonly string[], launchDaemons: string): string[] | null {
  const a = [...args];
  switch (command) {
    case 'launchctl': {
      if (a[0] === 'bootout' && a.length === 2) return wrap('bootout', systemLabel(a[1]));
      if (a[0] === 'bootstrap' && a[1] === 'system' && a.length === 3) return wrap('bootstrap', labelOf(a[2]!, launchDaemons));
      if (a[0] === 'kickstart' && a.length === 2) return wrap('kickstart', systemLabel(a[1]));
      if (a[0] === 'kickstart' && a[1] === '-k' && a.length === 3) return wrap('kickstart', systemLabel(a[2]), '-k');
      return null;
    }
    case 'install': {
      const [m, mode, o, owner, g, group, staged, dest] = a;
      if (a.length !== 8 || m !== '-m' || mode !== '644' || o !== '-o' || owner !== 'root' || g !== '-g' || group !== 'wheel') return null;
      const label = labelOf(dest!, launchDaemons);
      return label ? ['install', label, staged!] : null;
    }
    case 'rm':
      return a.length === 2 && a[0] === '-f' ? wrap('remove', labelOf(a[1]!, launchDaemons)) : null;
    case 'scutil':
      return a.length === 3 && a[0] === '--set' ? ['hostname', a[1]!, a[2]!] : null;
    case 'pmset':
      return a[0] === '-a' && a.length > 1 ? ['pmset', ...a.slice(1)] : null;
    case 'systemsetup':
      return a.length === 2 && a[0] === '-setremotelogin' && a[1] === 'on' ? ['remote-login'] : null;
    default:
      return null;
  }
}

function wrap(op: string, label: string | null, ...rest: string[]): string[] | null {
  return label ? [op, label, ...rest] : null;
}
