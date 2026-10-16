import { existsSync } from 'node:fs';
import type { DevhostConfig } from '@devhost/contract';
import { Db, dbPath } from '../collector/db.js';
import { accountsOf, effectiveClaudeDir, envDir, environmentsOf, findAccount } from '../config/accounts.js';
import { UsageError } from '../errors.js';
import type { Prompter } from '../prompter.js';
import type { Reporter } from '../reporter.js';
import type { Executor } from '../runner/executor.js';
import type { EnvironmentInfo, PluginContext, SessionInfo } from './api.js';

export function pluginContext(c: { config: DevhostConfig; name: string; home: string; user: string; nodePath: string; exec: Executor; reporter: Reporter; prompter: Prompter }): PluginContext {
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
    claudeDirs: accountsOf(c.config).map((a) => ({ account: a.name, dir: effectiveClaudeDir(a, c.home) })),
  };
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
