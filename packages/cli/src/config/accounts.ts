import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { expandHome } from './paths.js';

export type Account = NonNullable<DevhostConfig['accounts']>[number];
export type Environment = NonNullable<DevhostConfig['environments']>[number];

export const accountsOf = (c: DevhostConfig): Account[] => c.accounts ?? [];
export const environmentsOf = (c: DevhostConfig): Environment[] => c.environments ?? [];

export function accountRoot(a: Account, home: string): string {
  return expandHome(a.root, home);
}

/** CLAUDE_CONFIG_DIR value for the account; null for the default account (variable stays unset). */
export function claudeConfigDir(a: Account, home: string): string | null {
  return a.configDir ? expandHome(a.configDir, home) : null;
}

/** The directory Claude Code really uses (default account: ~/.claude). */
export function effectiveClaudeDir(a: Account, home: string): string {
  return claudeConfigDir(a, home) ?? join(home, '.claude');
}

/** Env vars that select the account's Claude config (empty for the default account). */
export function accountEnv(a: Account, home: string): Record<string, string> {
  const dir = claudeConfigDir(a, home);
  return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
}

/** Claude Code's project directory name for a path (paths longer than 200 characters get a hash: not handled). */
export const projectKey = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Where a Remote Control service started in `dir` remembers its environment and session between
 * runs. Claude Code reuses it only while it is younger than 4 hours; null for a path whose project
 * name Claude Code would hash.
 */
export function bridgePointerPath(a: Account, dir: string, home: string): string | null {
  const key = projectKey(dir);
  return key.length > 200 ? null : join(effectiveClaudeDir(a, home), 'projects', key, 'bridge-pointer.json');
}

export function envDir(a: Account, e: Environment, home: string): string {
  return join(accountRoot(a, home), e.name);
}

export function rcLabel(account: string, env: string): string {
  return `com.devhost.rc.${account}.${env}`;
}

export function logsDir(home: string): string {
  return join(home, 'Library', 'Logs', 'devhost');
}

export function rcLogPath(home: string, account: string, env: string): string {
  return join(logsDir(home), `rc-${account}-${env}.log`);
}

export function composeProject(env: string): string {
  return `devhost-${env}`;
}

export function findAccount(c: DevhostConfig, name: string): Account | undefined {
  return accountsOf(c).find((a) => a.name === name);
}
