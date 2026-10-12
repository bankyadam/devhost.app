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
