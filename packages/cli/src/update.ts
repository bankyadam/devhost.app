import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DevhostConfig, UpdateData } from '@devhost/contract';
import { Db, dbPath } from './collector/db.js';
import { parseLsofCwd, parsePs } from './collector/samplers.js';
import { long, newExecutor, newStepContext, type GlobalOptions } from './command-support.js';
import { accountsOf, envDir, environmentsOf, rcLabel } from './config/accounts.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';
import { daemonState, serviceEnv } from './launchd.js';
import { parseVersion } from './claude-version.js';
import { reattachInWorktree, reattachLabels } from './reattach.js';
import type { Reporter } from './reporter.js';
import type { Executor } from './runner/executor.js';
import { readState, whichBinary } from './state.js';
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
    return db
      .all<{ session_id: string; account: string; env: string }>("SELECT session_id, account, env FROM sessions WHERE state = 'running' AND last_activity_at >= ?", now - 24 * 3_600_000)
      .map((s) => `${s.account || '?'}/${s.env || '?'} · ${s.session_id.slice(0, 8)}`);
  } finally {
    db.close();
  }
}

interface LiveSession {
  account: string;
  env: string;
  key: string;
  dir: string;
}

/**
 * The sessions each Remote Control service runs now: its children started with `--session-id cse_…`,
 * in their worktree (or, without one, wherever the process works). `self` is the service this
 * process itself runs under, if any: restarting that one would end this command too.
 */
async function liveRemoteSessions(ctx: StepContext): Promise<{ labels: string[]; sessions: LiveSession[]; self: string | null }> {
  const { exec, config, home } = ctx;
  const procs = parsePs((await exec.query('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='])).stdout);
  const ancestors = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && !ancestors.has(pid); pid = procs.find((p) => p.pid === pid)?.ppid) ancestors.add(pid);
  const labels: string[] = [];
  const sessions: LiveSession[] = [];
  let self: string | null = null;
  const pending: { p: { pid: number }; s: LiveSession; fallback: string }[] = [];
  for (const e of environmentsOf(config)) {
    if (e.remoteControl?.enabled === false) continue;
    const a = accountsOf(config).find((x) => x.name === e.account);
    if (!a) continue;
    const label = rcLabel(a.name, e.name);
    const state = await daemonState(exec, label);
    if (!state.loaded) continue;
    labels.push(label);
    if (state.pid === null) continue;
    if (ancestors.has(state.pid)) self = label;
    for (const p of procs.filter((x) => x.ppid === state.pid)) {
      const key = /--session-id (cse_[A-Za-z0-9]+)/.exec(p.command)?.[1];
      if (!key) continue;
      const worktree = join(envDir(a, e, home), '.claude', 'worktrees', `bridge-${key}`);
      const s = { account: a.name, env: e.name, key, dir: worktree };
      if (existsSync(worktree)) sessions.push(s);
      else pending.push({ p, s, fallback: envDir(a, e, home) });
    }
  }
  if (pending.length > 0) {
    const cwds = parseLsofCwd((await exec.query('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pending.map((x) => x.p.pid).join(',')])).stdout);
    for (const x of pending) sessions.push({ ...x.s, dir: cwds.get(x.p.pid) ?? x.fallback });
  }
  return { labels, sessions, self };
}

export interface UpdateOptions {
  check: boolean;
  all: boolean;
  force: boolean;
  dryRun: boolean;
}

/**
 * Update Claude Code: upgrade it, restart every Remote Control service onto it (a service runs its
 * sessions from the versioned path the upgrade removes, so it cannot start new ones until it
 * restarts), then reattach the sessions the restart cut off. Waits while a session is in the middle
 * of a turn, unless forced. `--all` also upgrades the other Brewfile packages.
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

  if (wantClaude) {
    const busy = busySessions(home, now);
    if (busy.length > 0 && !o.force) {
      data.busy = busy;
      human.push(`⏳ Claude Code ${claude.installed} → ${claude.latest ?? 'latest'} waits: ${busy.length} session(s) are in the middle of a turn (${busy.join(', ')}). Run again later, or with --force to interrupt them (they are reattached).`);
    } else {
      const before = claude.installed;
      const live = await liveRemoteSessions(ctx);
      if (live.self && !o.dryRun) {
        throw new UsageError(
          `this command runs inside a session of ${live.self}, which the update restarts (that would end this command half way)`,
          'Run it from the devhost app, from a terminal on the host (ssh), or let the automatic update do it (claude.update: auto).',
        );
      }
      const reattachJobs: string[] = [];
      for (const l of await reattachLabels()) if ((await daemonState(exec, l)).running) reattachJobs.push(l);

      step('update.claude', `update Claude Code${claude.latest ? ` to ${claude.latest}` : ''}`);
      if (claude.install === 'brew') await exec.exec('brew', ['upgrade', '--cask', CASK], { env: BREW_ENV, progress: true, reason: 'update Claude Code' });
      else if (claude.path) await exec.exec(claude.path, ['update'], { reason: 'update Claude Code', progress: true });
      const after = o.dryRun ? claude.latest : claude.path ? versionText((await exec.query(claude.path, ['--version'])).stdout) : null;
      const changed = o.dryRun || (after !== null && after !== before);
      data.claude = { ...claude, installed: o.dryRun ? before : after, outdated: o.dryRun ? claude.outdated : false, updated: !o.dryRun && changed };
      reporter.step('update.claude', o.dryRun ? 'ok' : changed ? 'changed' : 'ok', o.dryRun ? 'planned' : changed ? `${before} → ${after}` : `${after} was current`);

      if (changed) {
        step('update.restart', 'restart the Remote Control services onto it');
        data.restarted = [];
        for (const label of [...live.labels, ...reattachJobs]) {
          await exec.exec('launchctl', ['kickstart', '-k', `system/${label}`], { sudo: true, reason: `restart ${label} on the new Claude Code` });
          data.restarted.push(label);
        }
        reporter.step('update.restart', o.dryRun ? 'ok' : 'changed', `${data.restarted.length} service(s)`);

        data.reattached = [];
        for (const s of live.sessions) {
          const a = accountsOf(config).find((x) => x.name === s.account)!;
          const e = environmentsOf(config).find((x) => x.name === s.env && x.account === s.account)!;
          const remote = { id: `session_${s.key.slice('cse_'.length)}`, key: s.key, dir: s.dir };
          try {
            // The old session process goes down with its service; give the server a moment.
            if (!o.dryRun) await exec.waitFor(async () => !(await exec.query('ps', ['-axo', 'command='])).stdout.includes(`--session-id ${s.key}`), 15, 1000);
            await reattachInWorktree(ctx, reporter, a, e, remote, o.dryRun);
            data.reattached.push({ remoteSession: remote.id, account: s.account, env: s.env, ok: true });
          } catch (err) {
            data.reattached.push({ remoteSession: remote.id, account: s.account, env: s.env, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        human.push(o.dryRun ? `Would update Claude Code ${before} → ${claude.latest ?? 'latest'} and restart ${data.restarted.length} service(s).` : `✅ Claude Code ${before} → ${after}; ${data.restarted.length} service(s) restarted.`);
        const failed = data.reattached.filter((r) => !r.ok);
        if (data.reattached.length) human.push(`${data.reattached.length - failed.length} of ${data.reattached.length} open session(s) reattached.${failed.map((f) => `\n  ❌ ${f.remoteSession}: ${f.error}`).join('')}`);
      } else {
        human.push(`Claude Code ${after} is current.`);
      }
    }
  } else {
    human.push(`Claude Code ${claude.installed ?? '(not installed)'} is current.`);
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
    const failed = (data.reattached ?? []).filter((r) => !r.ok);
    const plan = o.dryRun && exec.plan.length > 0 ? ['', 'Dry run plan (nothing was changed):', ...exec.plan.map((p) => `  ${p.sudo ? '[sudo] ' : ''}${p.action}${p.reason ? `  — ${p.reason}` : ''}`)] : [];
    if (failed.length) return { ok: false, data, human: [...human, ...plan], error: new DevhostError(`${failed.length} session(s) could not be reattached`, 'reattach-failed', 1, 'Reattach them from the dashboard, or with `devhost session reattach <id>`.') };
    return { ok: true, data, human: [...human, ...plan] };
  });
}
