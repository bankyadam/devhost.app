import type { DevhostConfig } from '@devhost/contract';
import { accountsOf, type Account } from '../config/accounts.js';
import { authStatus, claudeBinary, claudeRunOptions } from '../login.js';
import type { Deps } from '../deps.js';
import type { Executor } from '../runner/executor.js';
import type { Db } from './db.js';

/**
 * Per account: `claude auth status` with the account's environment (default account:
 * CLAUDE_CONFIG_DIR unset, never ~/.claude, which would read another Keychain entry; A10.4).
 * With `collector.authProbe` a cheap real request also has to succeed, for the case where
 * `auth status` stays green for an expired login (open question in the spec).
 */
export async function checkAuth(db: Db, exec: Executor, deps: Pick<Deps, 'home' | 'runner'>, config: DevhostConfig, now: number): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  for (const a of accountsOf(config)) {
    const valid = await accountValid(exec, deps, a, config.collector?.authProbe === true);
    if (valid === null) continue; // claude missing: not an auth problem
    result.set(a.name, valid);
    db.kvSet(`auth:${a.name}`, valid ? 'ok' : 'invalid', now);
    db.kvSet(`auth_checked:${a.name}`, String(now), now);
  }
  return result;
}

async function accountValid(exec: Executor, deps: Pick<Deps, 'home' | 'runner'>, a: Account, probe: boolean): Promise<boolean | null> {
  const status = await authStatus({ exec, deps: deps as Deps }, a);
  if (status.loggedIn === null) return null;
  if (!status.loggedIn || !probe) return status.loggedIn;
  const claude = await claudeBinary({ exec, deps: deps as Deps });
  const r = await exec.query(claude, ['-p', 'ok', '--max-turns', '1'], { ...claudeRunOptions(a, deps.home), timeoutMs: 60_000 });
  return r.code === 0;
}
