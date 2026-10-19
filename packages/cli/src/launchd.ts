import { CommandError } from './errors.js';
import { join } from 'node:path';
import { devhostConfigDir } from './config/paths.js';
import { logsDir } from './config/accounts.js';
import { renderTemplate } from './render.js';
import type { Executor } from './runner/executor.js';
import { ok, todo, type CheckResult, type StepContext } from './steps/types.js';

export interface DaemonSpec {
  label: string;
  args: string[];
  workingDirectory?: string;
  env: Record<string, string>;
  logPath: string;
  /** Seconds launchd waits between restarts. */
  throttle?: number;
  /** false: runs once when loaded, not restarted when it exits (default true). */
  keepAlive?: boolean;
  /**
   * Mark each start in the log and wait (up to 3 minutes) until this host resolves: at boot the
   * network comes up after launchd starts the daemons, and Claude Code exits on a failed lookup.
   */
  waitForHost?: string;
  /**
   * A command that must succeed after the network wait and before the program starts (the work
   * volume's `devhost storage wait`); when it fails the job exits and launchd retries it.
   */
  gate?: string[];
}

/** Overridable so tests never touch the real /Library/LaunchDaemons. */
export const launchDaemonsDir = (): string => process.env['DEVHOST_LAUNCHD_DIR'] ?? '/Library/LaunchDaemons';
export const plistPath = (label: string): string => `${launchDaemonsDir()}/${label}.plist`;
export const stagedPlistPath = (home: string, label: string): string => join(devhostConfigDir(home), 'launchd', `${label}.plist`);

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The service appends its own output to its log, through /bin/sh as the service's user. No
 * StandardOutPath: launchd opens that as root, so a symlink in the user's log directory could
 * point it at any file; the root helper refuses such plists (templates/devhost-root.js).
 */
export const LOG_WRAPPER = 'exec >>"$0" 2>&1 && exec "$@"';
/** The line that starts each run in a service log (`waitForHost` services). */
export const START_MARKER = '[devhost] started';
const HOST = /^[A-Za-z0-9.-]+$/;
const shq = (a: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export const networkWrapper = (host: string, gate?: string[]): string => {
  if (!HOST.test(host)) throw new Error(`not a host name: ${host}`);
  const before = gate?.length ? `${gate.map(shq).join(' ')} || exit 75; ` : '';
  return `exec >>"$0" 2>&1 && echo "${START_MARKER} $(date '+%Y-%m-%d %H:%M:%S')" && i=0 && until /usr/bin/dscacheutil -q host -a name ${host} | /usr/bin/grep -q address || [ $i -ge 90 ]; do i=$((i+1)); sleep 2; done; ${before}exec "$@"`;
};
/** The log wrapper with a gate and no network wait (Colima waiting for the work volume). */
export const gateWrapper = (gate: string[]): string => `exec >>"$0" 2>&1 && ${gate.map(shq).join(' ')} || exit 75; exec "$@"`;

export const loggedArgs = (spec: Pick<DaemonSpec, 'args' | 'logPath' | 'waitForHost' | 'gate'>): string[] => [
  '/bin/sh',
  '-c',
  spec.waitForHost ? networkWrapper(spec.waitForHost, spec.gate) : spec.gate?.length ? gateWrapper(spec.gate) : LOG_WRAPPER,
  spec.logPath,
  ...spec.args,
];

export async function renderPlist(spec: DaemonSpec, user: string): Promise<string> {
  return renderTemplate('launchd.plist', {
    label: xml(spec.label),
    user: xml(user),
    workingDirectory: spec.workingDirectory ? xml(spec.workingDirectory) : null,
    args: loggedArgs(spec).map(xml),
    env: Object.entries(spec.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key: xml(key), value: xml(value) })),
    throttle: spec.throttle ?? 30,
    keepAlive: spec.keepAlive !== false,
  });
}

export interface DaemonState {
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

/** PATH for services: launchd's own is minimal (spec A5). */
export const SERVICE_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function serviceEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, PATH: `${join(home, '.local', 'bin')}:${SERVICE_PATH}`, ...extra };
}

export async function daemonState(exec: Executor, label: string): Promise<DaemonState> {
  const r = await exec.query('launchctl', ['print', `system/${label}`]);
  if (r.code !== 0) return { loaded: false, running: false, pid: null };
  const pid = /\bpid = (\d+)/.exec(r.stdout);
  const running = /\bstate = running\b/.test(r.stdout) || pid !== null;
  return { loaded: true, running, pid: pid ? Number(pid[1]) : null };
}

export async function checkDaemon(ctx: StepContext, spec: DaemonSpec): Promise<CheckResult> {
  const want = await renderPlist(spec, ctx.user);
  const have = await ctx.exec.readText(plistPath(spec.label));
  if (have !== want) return todo(have === null ? `${spec.label} is not installed` : `${spec.label} plist is out of date`);
  const state = await daemonState(ctx.exec, spec.label);
  if (!state.loaded) return todo(`${spec.label} is not loaded`);
  if (!state.running) return todo(`${spec.label} is not running`);
  return ok();
}

/** Install the plist as a LaunchDaemon (runs at boot, no GUI login) and make sure it is running. */
export async function applyDaemon(ctx: StepContext, spec: DaemonSpec): Promise<void> {
  const { exec, home } = ctx;
  const want = await renderPlist(spec, ctx.user);
  const dest = plistPath(spec.label);
  const have = await exec.readText(dest);
  const state = await daemonState(exec, spec.label);

  await exec.mkdirp(logsDir(home));
  if (have !== want) {
    const staged = stagedPlistPath(home, spec.label);
    await exec.writeText(staged, want, { description: `stage ${staged}` });
    if (state.loaded) await stopDaemon(exec, spec.label, `stop ${spec.label} before updating it`);
    await exec.exec('install', ['-m', '644', '-o', 'root', '-g', 'wheel', staged, dest], { sudo: true, reason: `install ${dest}` });
    await bootstrapDaemon(exec, spec.label, `start ${spec.label} (runs at boot without a GUI login)`);
    return;
  }
  if (!state.loaded) {
    await bootstrapDaemon(exec, spec.label, `load ${spec.label}`);
  } else if (!state.running) {
    await exec.exec('launchctl', ['kickstart', '-k', `system/${spec.label}`], { sudo: true, reason: `restart ${spec.label}` });
  }
}

/**
 * `launchctl bootout` returns while launchd is still tearing the job down (a Remote Control
 * service first shuts its sessions down), and a `bootstrap` in that window fails with
 * "5: Input/output error". So wait until the job is gone.
 */
export async function stopDaemon(exec: Executor, label: string, reason: string): Promise<void> {
  await exec.exec('launchctl', ['bootout', `system/${label}`], { sudo: true, reason, allowFailure: true });
  await exec.waitFor(async () => !(await daemonState(exec, label)).loaded, 30, 1000);
}

/** Load the installed plist; an EIO from a job still going away is retried once it has gone. */
export async function bootstrapDaemon(exec: Executor, label: string, reason: string): Promise<void> {
  const args = ['bootstrap', 'system', plistPath(label)];
  const first = await exec.exec('launchctl', args, { sudo: true, reason, allowFailure: true });
  if (first.code === 0) return;
  if (first.code === 5) {
    await exec.waitFor(async () => !(await daemonState(exec, label)).loaded, 30, 1000);
    const again = await exec.exec('launchctl', args, { sudo: true, reason, allowFailure: true });
    if (again.code === 0 || (await daemonState(exec, label)).running) return;
    throw new CommandError(`launchctl ${args.join(' ')}`, again.code, again.stderr);
  }
  throw new CommandError(`launchctl ${args.join(' ')}`, first.code, first.stderr);
}

export async function daemonInstalled(exec: Executor, label: string): Promise<boolean> {
  return (await exec.readText(plistPath(label))) !== null || (await daemonState(exec, label)).loaded;
}

export async function removeDaemon(ctx: StepContext, label: string): Promise<void> {
  const { exec, home } = ctx;
  if ((await daemonState(exec, label)).loaded) {
    await exec.exec('launchctl', ['bootout', `system/${label}`], { sudo: true, reason: `stop ${label}`, allowFailure: true });
  }
  if ((await exec.readText(plistPath(label))) !== null) {
    await exec.exec('rm', ['-f', plistPath(label)], { sudo: true, reason: `remove ${plistPath(label)}` });
  }
  await exec.remove(stagedPlistPath(home, label));
}
