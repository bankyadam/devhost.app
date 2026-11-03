import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionReattachData } from '@devhost/contract';
import { Db, dbPath } from './collector/db.js';
import { long, newExecutor, newStepContext, type GlobalOptions } from './command-support.js';
import { environmentsOf, findAccount, logsDir, type Account, type Environment } from './config/accounts.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';
import { stripAnsi } from './login.js';
import { applyDaemon, daemonState, launchDaemonsDir, removeDaemon, type DaemonSpec } from './launchd.js';
import { rcSpec } from './steps/env.js';
import type { StepContext } from './steps/types.js';
import type { Reporter } from './reporter.js';

export const REATTACH_PREFIX = 'com.devhost.reattach.';

/**
 * A Remote Control service started with `--spawn worktree` runs each session in
 * `<env>/.claude/worktrees/bridge-cse_<id>`, and that session is `session_<id>` on claude.ai. The
 * session may have moved below it (the collector keeps its last directory), so any directory in
 * the worktree counts. Null for anything else (same-dir sessions, a terminal `claude`).
 */
export function remoteSessionOf(cwd: string): { id: string; key: string; dir: string } | null {
  const m = /^(.*\/\.claude\/worktrees\/bridge-cse_([A-Za-z0-9]+))(\/|$)/.exec(cwd);
  return m ? { id: `session_${m[2]}`, key: `cse_${m[2]}`, dir: m[1]! } : null;
}

/**
 * The Remote Control session process of a collector session: by its worktree, or, for a session the
 * service runs in the environment's own folder, by the claude.ai session the collector recorded.
 * Only worktree sessions can be reattached: a folder is served by one `remote-control` at a time.
 */
export function remoteSessionFrom(cwd: string, recorded: string | null): { id: string; key: string } | null {
  const worktree = remoteSessionOf(cwd);
  if (worktree) return worktree;
  const m = recorded ? /^session_([A-Za-z0-9]+)$/.exec(recorded) : null;
  return m ? { id: recorded!, key: `cse_${m[1]}` } : null;
}

/** Installed reattach jobs (their plists), running or ended. */
export async function reattachLabels(): Promise<string[]> {
  try {
    return (await readdir(launchDaemonsDir())).filter((f) => f.startsWith(REATTACH_PREFIX) && f.endsWith('.plist')).map((f) => f.slice(0, -'.plist'.length)).sort();
  } catch {
    return [];
  }
}

export function sessionRow(home: string, id: string): { session_id: string; account: string; env: string; cwd: string; state: string; turn_open: number } {
  if (!/^[A-Za-z0-9-]{8,}$/.test(id)) throw new UsageError('give a session id (at least its first 8 characters)');
  if (!existsSync(dbPath(home))) throw new UsageError('the collector has no sessions yet');
  const db = new Db(dbPath(home), { readonly: true });
  try {
    const rows = db.all<{ session_id: string; account: string; env: string; cwd: string; state: string; turn_open: number }>('SELECT session_id, account, env, cwd, state, turn_open FROM sessions WHERE session_id LIKE ? LIMIT 2', `${id}%`);
    if (rows.length === 0) throw new UsageError(`no session ${id}`);
    if (rows.length > 1) throw new UsageError(`${id} matches more than one session; give more of the id`);
    return rows[0]!;
  } finally {
    db.close();
  }
}

/**
 * `devhost session reattach <id>`: bring an ended Remote Control session back, e.g. after a reboot,
 * when the environment's service registered itself anew and the old session is left without a
 * machine. Runs `claude remote-control --session-id session_…` in the session's worktree as a
 * one-shot LaunchDaemon (no GUI login needed; not restarted when the session ends). Reattach jobs
 * that have ended are removed first.
 */
export function sessionReattachCommand(deps: Deps, g: GlobalOptions, id: string, dryRun: boolean): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const s = sessionRow(deps.home, id);
    const remote = remoteSessionOf(s.cwd);
    if (!remote) throw new UsageError(`session ${s.session_id.slice(0, 8)} did not run in a Remote Control worktree (${s.cwd || 'no directory'})`, 'Only sessions a Remote Control service started with --spawn worktree can be reattached; resume others with `claude --resume` in their directory.');
    if (s.state !== 'ended') throw new UsageError(`session ${s.session_id.slice(0, 8)} is still ${s.state}`, 'Open it on claude.ai; reattach is for a session whose process is gone.');
    const env = environmentsOf(config).find((e) => e.name === s.env && e.account === s.account);
    const account = findAccount(config, s.account);
    if (!env || !account) throw new UsageError(`environment ${s.account}/${s.env} is not in the config any more`);
    if (!existsSync(remote.dir)) throw new DevhostError(`the session's worktree is gone: ${remote.dir}`, 'worktree-missing', 1);

    const exec = newExecutor(deps, g, reporter, dryRun);
    const ctx = newStepContext(deps, g, config, exec);
    const { label, logPath, removed } = await reattachInWorktree(ctx, reporter, account, env, remote, dryRun);
    const url = `https://claude.ai/code/${remote.id}`;
    const data: SessionReattachData = { session: s.session_id, remoteSession: remote.id, account: s.account, env: s.env, url, label, logPath, ...(removed.length ? { removed } : {}), ...(dryRun ? { dryRun: true } : {}) };
    const plan = dryRun && exec.plan.length > 0 ? ['', 'Dry run plan (nothing was changed):', ...exec.plan.map((p) => `  ${p.sudo ? '[sudo] ' : ''}${p.action}${p.reason ? `  — ${p.reason}` : ''}`)] : [];
    return { ok: true, data, human: [dryRun ? `Would reattach ${remote.id}.` : `✅ Reattached: ${url}`, ...plan] };
  });
}

/**
 * Run `claude remote-control --session-id session_…` in the session's worktree as a one-shot
 * LaunchDaemon and wait until it connects (or remove it again and throw). Also used by
 * `devhost update` after the services restarted onto a new Claude Code.
 */
export async function reattachInWorktree(
  ctx: StepContext,
  reporter: Reporter,
  account: Account,
  env: Environment,
  remote: { id: string; key: string; dir: string },
  dryRun: boolean,
): Promise<{ label: string; logPath: string; removed: string[] }> {
  const { exec, home } = ctx;
  // The bridge pointer is the environment service's: the reattach job leaves it alone.
  const { pointer: _pointer, ...rc } = await rcSpec(ctx, account, env);
  const permissionMode = rc.args[rc.args.indexOf('--permission-mode') + 1]!;
  const spec: DaemonSpec = {
    ...rc,
    label: `${REATTACH_PREFIX}${remote.key}`,
    args: [rc.args[0]!, 'remote-control', '--session-id', remote.id, '--permission-mode', permissionMode],
    workingDirectory: remote.dir,
    logPath: join(logsDir(home), `rc-${account.name}-${env.name}-${remote.key}.log`),
    keepAlive: false,
  };

  const step = `session.reattach.${remote.key}`;
  exec.beginStep(step);
  reporter.step(step, 'start', `reattach ${remote.id} in ${env.name}`);
  if ((await daemonState(exec, spec.label)).running) throw new UsageError(`${remote.id} is attached already (${spec.label} is running)`, 'Open it on claude.ai.');

  // The log is appended to: only what this run writes counts.
  const logFrom = ((await exec.readText(spec.logPath)) ?? '').length;
  const newLog = async (): Promise<string> => stripAnsi(((await exec.readText(spec.logPath)) ?? '').slice(logFrom));
  const removed: string[] = [];
  for (const label of await reattachLabels()) {
    if (label === spec.label || (await daemonState(exec, label)).running) continue;
    await removeDaemon(ctx, label);
    removed.push(label);
  }
  await applyDaemon(ctx, spec);

  if (!dryRun) {
    // Connected, or it gave up (nothing to reattach to): its log says which.
    const running = async (): Promise<boolean> => (await daemonState(exec, spec.label)).running;
    await exec.waitFor(async () => /Connected/.test(await newLog()) || ((await newLog()).trim() !== '' && !(await running())), 30, 1000);
    if (!/Connected/.test(await newLog()) || !(await running())) {
      const tail = (await newLog()).split('\n').filter((l) => l.trim()).slice(-3).join(' / ');
      reporter.step(step, 'failed', tail || 'it did not connect');
      // Nothing to keep: left installed, it would only fail again at the next boot.
      await removeDaemon(ctx, spec.label);
      throw new DevhostError(`${remote.id} could not be reattached${tail ? `: ${tail}` : ''}`, 'reattach-failed', 1, `Log: ${spec.logPath}`);
    }
  }
  reporter.step(step, dryRun ? 'ok' : 'changed', dryRun ? 'planned' : 'connected');
  return { label: spec.label, logPath: spec.logPath, removed };
}
