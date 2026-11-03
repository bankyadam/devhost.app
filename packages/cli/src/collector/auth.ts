import type { DevhostConfig } from '@devhost/contract';
import { accountsOf, type Account } from '../config/accounts.js';
import { claudeBinary, claudeRunOptions, loginIdentity } from '../login.js';
import { TIMEOUT } from './sources.js';
import type { Deps } from '../deps.js';
import type { Executor } from '../runner/executor.js';
import type { Db } from './db.js';

/**
 * Per account: `claude auth status` with the account's environment (default account:
 * CLAUDE_CONFIG_DIR unset, never ~/.claude, which would read another Keychain entry; A10.4).
 * With `collector.authProbe` a cheap real request also has to succeed, for the case where
 * `auth status` stays green for an expired login (open question in the spec).
 */
export async function checkAuth(db: Db, exec: Executor, deps: Pick<Deps, 'home' | 'runner' | 'brewPrefix'>, config: DevhostConfig, now: number): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const owners: { org: Map<string, Set<string>>; email: Map<string, Set<string>> } = { org: new Map(), email: new Map() };
  const add = (m: Map<string, Set<string>>, key: string | undefined, account: string): void => {
    if (key) m.set(key, (m.get(key) ?? new Set()).add(account));
  };
  for (const a of accountsOf(config)) {
    const { valid, raw } = await accountValid(exec, deps, a, config.collector?.authProbe === true);
    if (valid === null) continue; // claude missing: not an auth problem
    result.set(a.name, valid);
    db.kvSet(`auth:${a.name}`, valid ? 'ok' : 'invalid', now);
    db.kvSet(`auth_checked:${a.name}`, String(now), now);
    if (valid) {
      const who = loginIdentity(raw);
      add(owners.org, who.orgId, a.name);
      add(owners.email, who.email, a.name);
    }
  }
  // Which login is which account, for telemetry from processes outside the account's config
  // directory (the Claude app). A key two accounts share decides nothing.
  for (const [kind, m] of Object.entries(owners)) {
    for (const [key, accounts] of m) {
      if (accounts.size === 1) db.kvSet(`auth_${kind}:${key}`, [...accounts][0]!, now);
      else db.run('DELETE FROM kv WHERE key = ?', `auth_${kind}:${key}`);
    }
  }
  return result;
}

async function accountValid(exec: Executor, deps: Pick<Deps, 'home' | 'runner' | 'brewPrefix'>, a: Account, probe: boolean): Promise<{ valid: boolean | null; raw: string }> {
  // `claude auth status` with the collector's own timeout (the generic one is minutes long).
  const claude0 = await claudeBinary({ exec, deps });
  const st = await exec.query(claude0, ['auth', 'status'], { ...claudeRunOptions(a, deps.home), timeoutMs: TIMEOUT.auth });
  const status = st.code === 127 ? { loggedIn: null, raw: st.stderr } : { loggedIn: st.code === 0, raw: st.stdout };
  if (status.loggedIn === null || !status.loggedIn || !probe) return { valid: status.loggedIn, raw: status.raw };
  const claude = await claudeBinary({ exec, deps });
  const r = await exec.query(claude, ['-p', 'ok', '--max-turns', '1', '--no-session-persistence', '--settings', '{"disableAllHooks":true}'], { ...claudeRunOptions(a, deps.home), timeoutMs: 60_000 });
  return { valid: r.code === 0, raw: status.raw };
}
