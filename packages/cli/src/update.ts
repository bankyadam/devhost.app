import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DevhostConfig, UpdateData } from '@devhost/contract';
import { Db, dbPath } from './collector/db.js';
import { parsePs } from './collector/samplers.js';
import { long, newExecutor, newStepContext, type GlobalOptions } from './command-support.js';
import { accountsOf, envDir, environmentsOf, rcLabel } from './config/accounts.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { UsageError } from './errors.js';
import { daemonState, removeDaemon, serviceEnv } from './launchd.js';
import { parseVersion } from './claude-version.js';
import { REATTACH_PREFIX, reattachLabels } from './reattach.js';
import type { Reporter } from './reporter.js';
import type { Executor } from './runner/executor.js';
import { readState, whichBinary, writeState } from './state.js';
import { requiredPackages } from './steps/packages.js';
import type { StepContext } from './steps/types.js';

const BREW_ENV = { HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_AUTO_UPDATE: '1' };
const CASK = 'claude-code';

const versionText = (text: string): string | null => parseVersion(text)?.join('.') ?? null;

/** a < b by numeric parts. */
export function olderThan(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

/** Is `at` inside "HH:MM-HH:MM" (local time; the range may wrap midnight)? */
export function inWindow(window: string, at: Date): boolean {
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(window);
  if (!m) return true;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  const now = at.getHours() * 60 + at.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** `claude` binaries the services would find on their PATH before the recorded one. */
export function shadowedClaudes(home: string, claudePath: string | null): string[] {
  if (!claudePath) return [];
  const out: string[] = [];
  for (const dir of serviceEnv(home).PATH!.split(':')) {
    if (dir === dirname(claudePath)) break;
    if (existsSync(join(dir, 'claude'))) out.push(join(dir, 'claude'));
  }
  return out;
}

async function brewJson<T>(exec: Executor, args: string[]): Promise<T | null> {
  const r = await exec.query('brew', args, { env: BREW_ENV });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

export async function claudeInfo(exec: Executor, home: string, config: DevhostConfig): Promise<UpdateData['claude']> {
  const install = config.claude?.install ?? 'brew';
  const path = (await readState(exec, home)).claudePath ?? (await whichBinary(exec, 'claude'));
  const installed = path ? versionText((await exec.query(path, ['--version'])).stdout) : null;
  let latest: string | null = null;
  if (install === 'brew') {
    const info = await brewJson<{ casks?: { version?: string }[] }>(exec, ['info', '--json=v2', '--cask', CASK]);
    latest = versionText(info?.casks?.[0]?.version ?? '');
  }
  return { install, path, installed, latest, outdated: installed !== null && latest !== null && olderThan(installed, latest), shadowed: shadowedClaudes(home, path) };
}

type Outdated = { name: string; installed_versions: string[] | string; current_version: string };

/** Outdated Brewfile packages, Claude Code aside (it has its own flow). */
export async function outdatedPackages(exec: Executor, config: DevhostConfig): Promise<UpdateData['packages']> {
  const want = requiredPackages(config);
  const data = await brewJson<{ formulae?: Outdated[]; casks?: Outdated[] }>(exec, ['outdated', '--json=v2']);
  const base = (n: string): string => n.split('/').pop()!;
  const first = (v: string[] | string): string => (Array.isArray(v) ? v[v.length - 1] ?? '' : v);
  const formulae = (data?.formulae ?? []).filter((f) => want.brew.some((b) => base(b) === base(f.name)));
  const casks = (data?.casks ?? []).filter((c) => c.name !== CASK && want.cask.some((b) => base(b) === base(c.name)));
  return [
    ...formulae.map((f) => ({ name: f.name, installed: first(f.installed_versions), latest: f.current_version, cask: false })),
    ...casks.map((c) => ({ name: c.name, installed: first(c.installed_versions), latest: c.current_version, cask: true })),
  ];
}

/** Sessions in the middle of a turn (the hooks said UserPromptSubmit, no Stop yet), seen in the last day. */
export function busySessions(home: string, now: number): string[] {
  if (!existsSync(dbPath(home))) return [];
  const db = new Db(dbPath(home), { readonly: true });
  try {
    const busy = (where: string): { session_id: string; account: string; env: string }[] =>
      db.all<{ session_id: string; account: string; env: string }>(`SELECT session_id, account, env FROM sessions WHERE ${where} AND last_activity_at >= ?`, now - 24 * 3_600_000);
    let rows;
    try {
      rows = busy("turn_open = 1 AND state <> 'ended'");
    } catch {
      rows = busy("state = 'running'"); // a database the collector has not migrated yet
    }
    return rows
      .map((s) => `${s.account || '?'}/${s.env || '?'} · ${s.session_id.slice(0, 8)}`);
  } finally {
    db.close();
  }
}

interface LiveSession {
  account: string;
  env: string;
  key: string;
}

/**
 * The Remote Control sessions open now, and the services running them: each environment's service
 * (its children started with `--session-id cse_…`) and any running reattach job (one session each).
 * `self` is the service this process itself runs under, if any: restarting it would end this command.
 */
async function liveRemoteSessions(ctx: StepContext): Promise<{ labels: string[]; reattachJobs: string[]; sessions: LiveSession[]; self: string | null }> {
  const { exec, config, home } = ctx;
  const procs = parsePs((await exec.query('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='])).stdout);
  const ancestors = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && !ancestors.has(pid); pid = procs.find((p) => p.pid === pid)?.ppid) ancestors.add(pid);
  const labels: string[] = [];
  const sessions: LiveSession[] = [];
  let self: string | null = null;
  const envs = environmentsOf(config).flatMap((e) => {
    const a = accountsOf(config).find((x) => x.name === e.account);
    return a && e.remoteControl?.enabled !== false ? [{ a, e, dir: envDir(a, e, home) }] : [];
  });
  for (const { a, e } of envs) {
    const label = rcLabel(a.name, e.name);
    const state = await daemonState(exec, label);
    if (!state.loaded) continue;
    labels.push(label);
    if (state.pid === null) continue;
    if (ancestors.has(state.pid)) self = label;
    for (const p of procs.filter((x) => x.ppid === state.pid)) {
      const key = /--session-id (cse_[A-Za-z0-9]+)/.exec(p.command)?.[1];
      if (key) sessions.push({ account: a.name, env: e.name, key });
    }
  }
  const reattachJobs: string[] = [];
  for (const label of await reattachLabels()) {
    const state = await daemonState(exec, label);
    if (!state.running) continue;
    reattachJobs.push(label);
    if (state.pid !== null && ancestors.has(state.pid)) self = label;
    const key = label.slice(REATTACH_PREFIX.length);
    const owner = envs.find((x) => existsSync(join(x.dir, '.claude', 'worktrees', `bridge-${key}`)));
    sessions.push({ account: owner?.a.name ?? '?', env: owner?.e.name ?? '?', key });
  }
  return { labels, reattachJobs, sessions, self };
}

export interface UpdateOptions {
  check: boolean;
  all: boolean;
  force: boolean;
  dryRun: boolean;
}

/**
 * Restart every label, collecting the failures instead of stopping at the first. The labels still
 * to restart are recorded in state.json first, and only the failed ones stay there: a run that dies
 * half way, or a service that would not restart, is retried by the next `devhost update`.
 */
async function restartServices(ctx: StepContext, labels: string[], done: string[], dryRun: boolean, already: string[] = []): Promise<{ label: string; error: string }[]> {
  const { exec, home } = ctx;
  const failures: { label: string; error: string }[] = [];
  const mark = async (pending: string[]): Promise<void> => {
    if (dryRun) return;
    const state = await readState(exec, home);
    const next = { ...state };
    delete next.restartPending;
    await writeState(exec, home, pending.length ? { ...next, restartPending: pending } : next);
  };
  await mark([...new Set([...already, ...labels])]);
  for (const label of labels) {
    try {
      await exec.exec('launchctl', ['kickstart', '-k', `system/${label}`], { sudo: true, reason: `restart ${label} on the new Claude Code` });
      done.push(label);
    } catch (err) {
      failures.push({ label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Labels not loaded any more (already dropped from `labels`) need no restart.
  await mark(failures.map((f) => f.label));
  return failures;
}

/**
 * Update Claude Code: upgrade it, restart every Remote Control service onto it (a service runs its
 * sessions from the versioned path the upgrade removes, so it cannot start new ones until it
 * restarts). The sessions it had open continue under it from claude.ai. Waits while a session is in
 * the middle of a turn, unless forced. `--all` also upgrades the other Brewfile packages.
 */
export async function runUpdate(ctx: StepContext, reporter: Reporter, now: number, o: UpdateOptions): Promise<{ data: UpdateData; human: string[] }> {
  const { exec, config, home } = ctx;
  const step = (id: string, msg: string): void => {
    exec.beginStep(id);
    reporter.step(id, 'start', msg);
  };

  step('update.check', 'look for new versions');
  if ((config.claude?.install ?? 'brew') === 'brew' || o.all) {
    // Fresh formula data first; a failure (offline) leaves the last known one.
    await exec.query('brew', ['update', '--quiet'], { env: BREW_ENV });
  }
  const claude = await claudeInfo(exec, home, config);
  const packages = await outdatedPackages(exec, config);
  reporter.step('update.check', 'ok', claude.outdated ? `Claude Code ${claude.installed} → ${claude.latest}` : `Claude Code ${claude.installed ?? 'not installed'} is current`);
  const data: UpdateData = { claude, packages, checkedAt: now, ...(o.dryRun ? { dryRun: true } : {}) };
  const human: string[] = [];
  if (claude.shadowed?.length) human.push(`⚠️ ${claude.shadowed.join(', ')} comes before ${claude.path} on the services' PATH: anything calling \`claude\` by name gets that one.`);

  // Native installs only learn of a new version by updating.
  const wantClaude = !o.check && (claude.outdated || (claude.install === 'native' && claude.installed !== null));
  if (o.check) {
    human.unshift(claude.outdated ? `Claude Code ${claude.installed} → ${claude.latest} is available.` : `Claude Code ${claude.installed ?? '(not installed)'}${claude.latest ? ' is current' : ''}.`);
    if (packages.length) human.push(`${packages.length} other package(s) outdated: ${packages.map((p) => `${p.name} ${p.installed} → ${p.latest}`).join(', ')}`);
    return { data, human };
  }

  let restartDone = false;
  if (wantClaude) {
    const busy = busySessions(home, now);
    if (busy.length > 0 && !o.force) {
      data.busy = busy;
      human.push(`⏳ Claude Code ${claude.installed} → ${claude.latest ?? 'latest'} waits: ${busy.length} session(s) are in the middle of a turn (${busy.join(', ')}). Run again later, or with --force to interrupt them (they continue on claude.ai afterwards).`);
    } else {
      const before = claude.installed;
      const live = await liveRemoteSessions(ctx);
      if (live.self && !o.dryRun) {
        throw new UsageError(
          `this command runs inside a session of ${live.self}, which the update restarts (that would end this command half way)`,
          'Run it from the devhost app, from a terminal on the host (ssh), or let the automatic update do it (claude.update: auto).',
        );
      }
      step('update.claude', `update Claude Code${claude.latest ? ` to ${claude.latest}` : ''}`);
      if (claude.install === 'brew') await exec.exec('brew', ['upgrade', '--cask', CASK], { env: BREW_ENV, progress: true, reason: 'update Claude Code' });
      else if (claude.path) await exec.exec(claude.path, ['update'], { reason: 'update Claude Code', progress: true });
      const after = o.dryRun ? claude.latest : claude.path ? versionText((await exec.query(claude.path, ['--version'])).stdout) : null;
      // An unknown version after the upgrade is no proof that nothing changed: restart anyway.
      const changed = o.dryRun || after === null || before === null || after !== before;
      data.claude = { ...claude, installed: o.dryRun ? before : after, outdated: o.dryRun ? claude.outdated : false, updated: !o.dryRun && changed };
      reporter.step('update.claude', o.dryRun ? 'ok' : changed ? 'changed' : 'ok', o.dryRun ? 'planned' : changed ? `${before} → ${after}` : `${after} was current`);

      if (changed) {
        // Each service restarts onto the new version; its open sessions are detached and continue
        // under it as soon as someone writes in them on claude.ai. Reattach jobs go: one would
        // register its own single-session environment and hide the environment on claude.ai.
        step('update.restart', 'restart the Remote Control services onto it');
        data.restarted = [];
        const failures = await restartServices(ctx, live.labels, data.restarted, o.dryRun);
        for (const label of live.reattachJobs) await removeDaemon(ctx, label);
        if (live.reattachJobs.length) data.removed = live.reattachJobs;
        reporter.step('update.restart', failures.length ? 'failed' : o.dryRun ? 'ok' : 'changed', failures.length ? `${failures.length} service(s) not restarted; the next run retries` : `${data.restarted.length} service(s)`);
        if (failures.length) human.push(`⚠️ Could not restart ${failures.map((f) => f.label).join(', ')}; \`devhost update\` retries them.${failures.map((f) => `\n  ${f.label}: ${f.error}`).join('')}`);
        restartDone = true;
        data.detached = live.sessions.map((s) => {
          const id = `session_${s.key.slice('cse_'.length)}`;
          return { remoteSession: id, account: s.account, env: s.env, url: `https://claude.ai/code/${id}` };
        });
        human.push(o.dryRun ? `Would update Claude Code ${before} → ${claude.latest ?? 'latest'} and restart ${data.restarted.length} service(s).` : `✅ Claude Code ${before} → ${after}; ${data.restarted.length} service(s) restarted.`);
        if (data.detached.length) human.push(`${data.detached.length} open session(s) continue on claude.ai as soon as you write in them:${data.detached.map((d) => `\n  ${d.account}/${d.env}: ${d.url}`).join('')}`);
      } else {
        human.push(`Claude Code ${after} is current.`);
      }
    }
  } else {
    human.push(`Claude Code ${claude.installed ?? '(not installed)'} is current.`);
  }

  // A restart an earlier run could not finish (marker in state.json) is retried now.
  if (!restartDone && !o.check && !o.dryRun && !data.busy) {
    const pending = (await readState(exec, home)).restartPending ?? [];
    if (pending.length > 0) {
      const live = await liveRemoteSessions(ctx);
      const labels = pending.filter((l) => live.labels.includes(l));
      step('update.restart', 'finish restarting the Remote Control services');
      data.restarted = [];
      const failures = await restartServices(ctx, labels, data.restarted, false, pending);
      reporter.step('update.restart', failures.length ? 'failed' : 'changed', failures.length ? `${failures.length} service(s) not restarted; the next run retries` : `${data.restarted.length} service(s)`);
      human.push(failures.length ? `⚠️ Could not restart ${failures.map((f) => f.label).join(', ')}; \`devhost update\` retries them.` : `✅ ${data.restarted.length} pending service restart(s) done.`);
    }
  }

  if (o.all && packages.length) {
    step('update.packages', `upgrade ${packages.length} package(s)`);
    const formulae = packages.filter((p) => !p.cask).map((p) => p.name);
    const casks = packages.filter((p) => p.cask).map((p) => p.name);
    if (formulae.length) await exec.exec('brew', ['upgrade', ...formulae], { env: BREW_ENV, progress: true, reason: 'upgrade the Brewfile packages' });
    if (casks.length) await exec.exec('brew', ['upgrade', '--cask', ...casks], { env: BREW_ENV, progress: true, reason: 'upgrade the Brewfile casks' });
    data.packages = packages.map((p) => ({ ...p, updated: !o.dryRun }));
    reporter.step('update.packages', o.dryRun ? 'ok' : 'changed', packages.map((p) => p.name).join(', '));
    human.push(`${o.dryRun ? 'Would upgrade' : '✅ Upgraded'} ${packages.map((p) => `${p.name} ${p.latest}`).join(', ')}.`);
  } else if (packages.length) {
    human.push(`${packages.length} other package(s) outdated (devhost update --all): ${packages.map((p) => p.name).join(', ')}`);
  }
  return { data, human };
}

export function updateCommand(deps: Deps, g: GlobalOptions, o: UpdateOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, reporter, o.dryRun);
    const ctx = newStepContext(deps, g, config, exec);
    const { data, human } = await runUpdate(ctx, reporter, deps.now().getTime(), o);
    const plan = o.dryRun && exec.plan.length > 0 ? ['', 'Dry run plan (nothing was changed):', ...exec.plan.map((p) => `  ${p.sudo ? '[sudo] ' : ''}${p.action}${p.reason ? `  — ${p.reason}` : ''}`)] : [];
    return { ok: true, data, human: [...human, ...plan] };
  });
}
