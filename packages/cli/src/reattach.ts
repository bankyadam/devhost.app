import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionReattachData } from '@devhost/contract';
import { Db, dbPath } from './collector/db.js';
import { long, newExecutor, newStepContext, type GlobalOptions } from './command-support.js';
import { accountEnv, effectiveClaudeDir, environmentsOf, findAccount, logsDir, type Account, type Environment } from './config/accounts.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';
import { stripAnsi } from './login.js';
import { applyDaemon, daemonState, launchDaemonsDir, removeDaemon, type DaemonSpec } from './launchd.js';
import type { Executor } from './runner/executor.js';
import { toolPath } from './state.js';
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

/** A background session's file (`<claude dir>/sessions/<pid>.json`) while it runs, found by its job id (and, given `accept`, its pid). */
export async function bgSessionFile(claudeDir: string, jobId: string, accept: (pid: number) => boolean = () => true): Promise<{ pid: number; sessionId: string; cwd: string | null; bridgeSessionId: string | null } | null> {
  let names: string[];
  try {
    names = (await readdir(join(claudeDir, 'sessions'))).filter((f) => /^\d+\.json$/.test(f) && accept(Number(f.slice(0, -'.json'.length))));
  } catch {
    return null;
  }
  for (const f of names) {
    try {
      const j = JSON.parse(await readFile(join(claudeDir, 'sessions', f), 'utf8')) as { sessionId?: unknown; jobId?: unknown; cwd?: unknown; bridgeSessionId?: unknown };
      if (j.jobId !== jobId || typeof j.sessionId !== 'string') continue;
      const bridge = typeof j.bridgeSessionId === 'string' && /^session_[A-Za-z0-9]+$/.test(j.bridgeSessionId) ? j.bridgeSessionId : null;
      return { pid: Number(f.slice(0, -'.json'.length)), sessionId: j.sessionId, cwd: typeof j.cwd === 'string' ? j.cwd : null, bridgeSessionId: bridge };
    } catch {
      /* a file being written, or not one of ours */
    }
  }
  return null;
}

/**
 * The saved job of a background session (`claude --bg`, e.g. `devhost session start`):
 * `<claude dir>/jobs/<short id>/state.json`, kept after `claude stop` and a reboot until `claude rm`.
 * It holds the options the session was started with, which `claude --bg --resume <id>` reuses.
 */
export async function bgJobOf(claudeDir: string, sessionId: string): Promise<{ jobId: string; dir: string | null; remoteSession: string | null } | null> {
  const read = async (short: string): Promise<{ jobId: string; dir: string | null; remoteSession: string | null } | null> => {
    try {
      const j = JSON.parse(await readFile(join(claudeDir, 'jobs', short, 'state.json'), 'utf8')) as { sessionId?: unknown; worktreePath?: unknown; cwd?: unknown; bridgeSessionId?: unknown };
      if (j.sessionId !== sessionId) return null;
      const dir = typeof j.worktreePath === 'string' ? j.worktreePath : typeof j.cwd === 'string' ? j.cwd : null;
      const m = typeof j.bridgeSessionId === 'string' ? /^(?:cse|session)_([A-Za-z0-9]+)$/.exec(j.bridgeSessionId) : null;
      return { jobId: short, dir, remoteSession: m ? `session_${m[1]}` : null };
    } catch {
      return null;
    }
  };
  // The job is named after the session id's first block; a copy started from it is not.
  const own = await read(sessionId.slice(0, 8));
  if (own) return own;
  let shorts: string[];
  try {
    shorts = (await readdir(join(claudeDir, 'jobs'))).filter((f) => /^[0-9a-f]{6,}$/.test(f));
  } catch {
    return null;
  }
  for (const short of shorts) {
    const job = await read(short);
    if (job) return job;
  }
  return null;
}

export interface SessionReattachOptions {
  dryRun: boolean;
  /** Tests shorten the wait for Remote Control. */
  waitMs?: number;
}

/** How long a resumed background session gets to write its session file and connect to Remote Control. */
const RESUME_WAIT_MS = 30_000;
const RESUME_POLL_MS = 500;

/**
 * `devhost session reattach <id>`: bring an ended Remote Control session back, e.g. after a reboot
 * or `claude stop`.
 * - A session a Remote Control service ran in its worktree (`--spawn worktree`): the environment's
 *   service registered itself anew and the old session is left without a machine. Runs
 *   `claude remote-control --session-id session_…` in the session's worktree as a one-shot
 *   LaunchDaemon (no GUI login needed; not restarted when the session ends). Reattach jobs that
 *   have ended are removed first.
 * - A background session (`devhost session start`, `claude --bg`): `claude --bg --resume <id>` in
 *   its worktree with its account, which continues the same job (same id, claude.ai session, name,
 *   permission mode and model).
 */
export function sessionReattachCommand(deps: Deps, g: GlobalOptions, id: string, opts: SessionReattachOptions): Promise<number> {
  const { dryRun } = opts;
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const s = sessionRow(deps.home, id);
    const short = s.session_id.slice(0, 8);
    const env = environmentsOf(config).find((e) => e.name === s.env && e.account === s.account);
    const account = findAccount(config, s.account);
    const remote = remoteSessionOf(s.cwd);
    const job = !remote && account ? await bgJobOf(effectiveClaudeDir(account, deps.home), s.session_id) : null;
    if (!remote && !job) {
      throw new UsageError(
        `session ${short} did not run in a Remote Control worktree or as a background session (${s.cwd || 'no directory'})`,
        'Sessions from devhost session start (claude --bg) and those a Remote Control service started with --spawn worktree can be reattached; resume others with `claude --resume` in their directory.',
      );
    }
    if (s.state !== 'ended') throw new UsageError(`session ${short} is already running (${s.state})`, job ? `Open it on claude.ai or with claude attach ${job.jobId}.` : 'Open it on claude.ai; reattach is for a session whose process is gone.');
    if (!env || !account) throw new UsageError(`environment ${s.account}/${s.env} is not in the config any more`);

    const exec = newExecutor(deps, g, reporter, dryRun);
    const plan = (): string[] => (dryRun && exec.plan.length > 0 ? ['', 'Dry run plan (nothing was changed):', ...exec.plan.map((p) => `  ${p.sudo ? '[sudo] ' : ''}${p.action}${p.reason ? `  — ${p.reason}` : ''}`)] : []);
    if (job) {
      const r = await resumeBackground(deps, exec, reporter, account, env, s.session_id, job, s.cwd, opts);
      const url = `https://claude.ai/code/${r.remoteSession}`;
      const data: SessionReattachData = { kind: 'background', session: s.session_id, remoteSession: r.remoteSession, account: s.account, env: s.env, url, label: job.jobId, jobId: job.jobId, logPath: r.logPath, ...(dryRun ? { dryRun: true } : {}) };
      return { ok: true, data, human: [dryRun ? `Would resume ${short} (job ${job.jobId}) in ${r.dir}.` : `✅ Resumed ${short} (job ${job.jobId}): ${url}`, ...plan()] };
    }
    if (!existsSync(remote!.dir)) throw new DevhostError(`the session's worktree is gone: ${remote!.dir}`, 'worktree-missing', 1);
    const ctx = newStepContext(deps, g, config, exec);
    const { label, logPath, removed } = await reattachInWorktree(ctx, reporter, account, env, remote!, dryRun);
    const url = `https://claude.ai/code/${remote!.id}`;
    const data: SessionReattachData = { kind: 'rc-service', session: s.session_id, remoteSession: remote!.id, account: s.account, env: s.env, url, label, logPath, ...(removed.length ? { removed } : {}), ...(dryRun ? { dryRun: true } : {}) };
    return { ok: true, data, human: [dryRun ? `Would reattach ${remote!.id}.` : `✅ Reattached: ${url}`, ...plan()] };
  });
}

/**
 * `claude --bg --resume <id>` without options: it continues the saved job under the same id with the
 * options it was started with. Given options, or while the session runs, it would start a copy
 * instead, so a running session (its session file's process is alive) is refused first, and a copy
 * that starts anyway is stopped again.
 */
async function resumeBackground(
  deps: Deps,
  exec: Executor,
  reporter: Reporter,
  account: Account,
  env: Environment,
  sessionId: string,
  job: { jobId: string; dir: string | null; remoteSession: string | null },
  lastCwd: string,
  opts: SessionReattachOptions,
): Promise<{ remoteSession: string; logPath: string; dir: string }> {
  const claudeDir = effectiveClaudeDir(account, deps.home);
  const logPath = join(claudeDir, 'daemon.log');
  const dir = job.dir ?? lastCwd;
  if (!dir || !existsSync(dir)) {
    throw new DevhostError(`the session's worktree is gone: ${dir || 'no directory'}`, 'worktree-missing', 1, `It was removed (claude rm ${job.jobId}, or by hand); start a new session with devhost session start.`);
  }
  const step = `session.reattach.${job.jobId}`;
  exec.beginStep(step);
  reporter.step(step, 'start', `resume ${sessionId.slice(0, 8)} in ${env.name}`);

  // A session file names the process while it runs; one left behind by a crash or a reboot names a dead one.
  const ps = await exec.query('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], { timeoutMs: 10_000 });
  const live = new Set(ps.stdout.split('\n').map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => n > 0));
  const running = await bgSessionFile(claudeDir, job.jobId, (pid) => live.has(pid));
  if (running) {
    reporter.step(step, 'failed', 'already running');
    throw new UsageError(`session ${sessionId.slice(0, 8)} is already running (pid ${running.pid})`, `Open it on claude.ai or with claude attach ${job.jobId}.`);
  }
  let stale = new Set<number>();
  try {
    stale = new Set((await readdir(join(claudeDir, 'sessions'))).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -'.json'.length))));
  } catch {
    /* no sessions folder yet */
  }

  const claude = await toolPath(exec, deps.home, 'claudePath', 'claude', `${deps.brewPrefix}/bin/claude`);
  const aenv = accountEnv(account, deps.home);
  const r = await exec.exec(claude, ['--bg', '--resume', sessionId], {
    cwd: dir,
    timeoutMs: 60_000,
    allowFailure: true,
    reason: `continue background job ${job.jobId} with its saved options`,
    env: { ...aenv, DEVHOST_PORT_BASE: String(env.portBase ?? 0), OTEL_RESOURCE_ATTRIBUTES: `devhost.account=${account.name},devhost.env=${env.name}` },
    ...(aenv['CLAUDE_CONFIG_DIR'] ? {} : { unsetEnv: ['CLAUDE_CONFIG_DIR'] }),
  });
  if (exec.dryRun) {
    reporter.step(step, 'ok', 'planned');
    return { remoteSession: job.remoteSession ?? '', logPath, dir };
  }
  // eslint-disable-next-line no-control-regex
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const started = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(out)?.[1];
  if (r.code !== 0 || !started) {
    reporter.step(step, 'failed');
    throw new DevhostError(`claude did not resume the session (exit ${r.code}): ${out.trim().split('\n').pop() ?? ''}`, 'reattach-failed', 1, `Log: ${logPath}`);
  }
  if (started !== job.jobId) {
    // A copy, not the session: stop and remove it (it has no worktree of its own).
    await exec.exec(claude, ['stop', started], { cwd: dir, env: aenv, allowFailure: true, timeoutMs: 30_000 });
    await exec.exec(claude, ['rm', started], { cwd: dir, env: aenv, allowFailure: true, timeoutMs: 30_000 });
    reporter.step(step, 'failed', `claude started a copy (${started}); it was removed`);
    throw new DevhostError(`claude started a copy of ${sessionId.slice(0, 8)} instead of continuing it`, 'reattach-failed', 1, `Is it running elsewhere? See claude agents.`);
  }

  const fresh = (pid: number): boolean => !stale.has(pid);
  const deadline = Date.now() + (opts.waitMs ?? RESUME_WAIT_MS);
  let file = await bgSessionFile(claudeDir, job.jobId, fresh);
  while (!file?.bridgeSessionId && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, RESUME_POLL_MS));
    file = await bgSessionFile(claudeDir, job.jobId, fresh);
  }
  const remoteSession = file?.bridgeSessionId ?? job.remoteSession;
  if (!file || !remoteSession) {
    reporter.step(step, 'failed', file ? 'not on Remote Control' : 'no session file');
    throw new DevhostError(`session ${sessionId.slice(0, 8)} was resumed but ${file ? 'is not on Remote Control' : 'wrote no session file'}`, 'reattach-failed', 1, `See claude logs ${job.jobId}; stop it with claude stop ${job.jobId}.`);
  }
  reporter.step(step, 'changed', file.bridgeSessionId ? 'connected' : 'resumed');
  return { remoteSession, logPath, dir };
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
