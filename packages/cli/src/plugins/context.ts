import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import type { DashData, DevhostConfig } from '@devhost/contract';
import { buildDash } from '../collector/query.js';
import { Db, dbPath } from '../collector/db.js';
import { accountsOf, effectiveClaudeDir, envDir, environmentsOf, findAccount, rcLabel } from '../config/accounts.js';
import { daemonState } from '../launchd.js';
import { UsageError } from '../errors.js';
import type { Prompter } from '../prompter.js';
import type { Reporter } from '../reporter.js';
import type { Executor } from '../runner/executor.js';
import type { EnvironmentInfo, PluginContext, ServiceInfo, SessionInfo, SessionState, StatsQuery } from './api.js';

export function pluginContext(c: { config: DevhostConfig; name: string; home: string; user: string; nodePath: string; exec: Executor; reporter: Reporter; prompter: Prompter; now?: () => number }): PluginContext {
  const environments: EnvironmentInfo[] = environmentsOf(c.config).flatMap((e) => {
    const a = findAccount(c.config, e.account);
    return a ? [{ name: e.name, account: e.account, dir: envDir(a, e, c.home) }] : [];
  });
  return {
    config: c.config,
    options: (c.config.plugins?.[c.name]?.options ?? {}) as Record<string, unknown>,
    home: c.home,
    user: c.user,
    nodePath: c.nodePath,
    exec: c.exec,
    reporter: c.reporter,
    prompter: c.prompter,
    environments,
    sessions: async () => readSessions(c.home),
    services: async (): Promise<ServiceInfo[]> => {
      const out: ServiceInfo[] = [];
      for (const e of environmentsOf(c.config)) {
        const label = rcLabel(e.account, e.name);
        const enabled = e.remoteControl?.enabled !== false;
        const s = enabled ? await daemonState(c.exec, label) : { running: false, pid: null };
        out.push({ environment: e.name, account: e.account, label, enabled, running: s.running, pid: s.pid });
      }
      return out;
    },
    claudeDirs: accountsOf(c.config).map((a) => ({ account: a.name, dir: effectiveClaudeDir(a, c.home) })),
    stats: async (q: StatsQuery): Promise<DashData | null> => {
      const path = dbPath(c.home);
      if (!existsSync(path)) return null;
      const db = new Db(path, { readonly: true });
      try {
        return buildDash(db, c.config, q, (c.now ?? Date.now)(), hostname(), null);
      } finally {
        db.close();
      }
    },
  };
}

function readSessions(home: string): SessionState[] {
  const path = dbPath(home);
  if (!existsSync(path)) return [];
  const db = new Db(path, { readonly: true });
  try {
    return db
      .all<{ session_id: string; account: string; env: string; cwd: string; state: SessionState['state']; last_activity_at: number }>('SELECT session_id, account, env, cwd, state, last_activity_at FROM sessions ORDER BY last_activity_at DESC')
      .map((r) => ({ id: r.session_id, account: r.account, env: r.env, cwd: r.cwd, state: r.state, lastActivityAt: r.last_activity_at }));
  } finally {
    db.close();
  }
}

export function findEnvironment(ctx: PluginContext, name: string): EnvironmentInfo {
  const e = ctx.environments.find((x) => x.name === name);
  if (!e) throw new UsageError(`no environment named "${name}"`);
  return e;
}

/** A session the collector knows, by its id or an unambiguous prefix of at least 8 characters (what the dashboard shows). */
export function findSession(home: string, id: string): SessionInfo {
  if (!/^[A-Za-z0-9-]{8,}$/.test(id)) throw new UsageError('--session takes a session id (at least its first 8 characters)');
  const path = dbPath(home);
  if (!existsSync(path)) throw new UsageError('the collector has no sessions yet');
  const db = new Db(path, { readonly: true });
  try {
    const rows = db.all<{ session_id: string; account: string; env: string; cwd: string }>('SELECT session_id, account, env, cwd FROM sessions WHERE session_id LIKE ? LIMIT 2', `${id}%`);
    if (rows.length === 0) throw new UsageError(`no session ${id}`);
    if (rows.length > 1) throw new UsageError(`${id} matches more than one session; give more of the id`);
    const r = rows[0]!;
    return { id: r.session_id, account: r.account, env: r.env, cwd: r.cwd };
  } finally {
    db.close();
  }
}
