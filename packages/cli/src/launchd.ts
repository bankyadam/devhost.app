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
}

/** Overridable so tests never touch the real /Library/LaunchDaemons. */
export const launchDaemonsDir = (): string => process.env['DEVHOST_LAUNCHD_DIR'] ?? '/Library/LaunchDaemons';
export const plistPath = (label: string): string => `${launchDaemonsDir()}/${label}.plist`;
export const stagedPlistPath = (home: string, label: string): string => join(devhostConfigDir(home), 'launchd', `${label}.plist`);

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function renderPlist(spec: DaemonSpec, user: string): Promise<string> {
  return renderTemplate('launchd.plist', {
    label: xml(spec.label),
    user: xml(user),
    workingDirectory: spec.workingDirectory ? xml(spec.workingDirectory) : null,
    args: spec.args.map(xml),
    env: Object.entries(spec.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key: xml(key), value: xml(value) })),
    throttle: spec.throttle ?? 30,
    logPath: xml(spec.logPath),
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
    if (state.loaded) {
      await exec.exec('launchctl', ['bootout', `system/${spec.label}`], { sudo: true, reason: `stop ${spec.label} before updating it`, allowFailure: true });
    }
    await exec.exec('install', ['-m', '644', '-o', 'root', '-g', 'wheel', staged, dest], { sudo: true, reason: `install ${dest}` });
    await exec.exec('launchctl', ['bootstrap', 'system', dest], { sudo: true, reason: `start ${spec.label} (runs at boot without a GUI login)` });
    return;
  }
  if (!state.loaded) {
    await exec.exec('launchctl', ['bootstrap', 'system', dest], { sudo: true, reason: `load ${spec.label}` });
  } else if (!state.running) {
    await exec.exec('launchctl', ['kickstart', '-k', `system/${spec.label}`], { sudo: true, reason: `restart ${spec.label}` });
  }
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
