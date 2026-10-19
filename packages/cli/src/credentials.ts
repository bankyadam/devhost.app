import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { claudeConfigDir, effectiveClaudeDir, type Account } from './config/accounts.js';
import type { Executor } from './runner/executor.js';

/**
 * Where the account's services find its login. They run as LaunchDaemons, outside the GUI session,
 * so they cannot read the login Keychain: Claude Code falls back to `.credentials.json` in the config
 * directory. A sign-in where the Keychain was writable (a terminal on the Mac) stores the new login
 * there and leaves that file as it was: the services keep running on the old login while
 * `claude auth status` (which shows the profile in `.claude.json`) reports the new one.
 */
export const credentialsFile = (a: Account, home: string): string => join(effectiveClaudeDir(a, home), '.credentials.json');

/** Claude Code's Keychain item for the account (the default config directory has no suffix). */
export function keychainService(a: Account, home: string): string {
  const dir = claudeConfigDir(a, home);
  return dir ? `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}` : 'Claude Code-credentials';
}

type Oauth = { claudeAiOauth?: { accessToken?: unknown } };

const accessToken = (text: string | null): string | null => {
  if (!text) return null;
  try {
    const t = (JSON.parse(text) as Oauth).claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
};

/** Who a token belongs to (claude.ai's profile endpoint); null when that cannot be told (expired, offline). */
export type ProfileFetch = (token: string) => Promise<{ email?: string; orgId?: string } | null>;

export const fetchProfile: ProfileFetch = async (token) => {
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/profile', { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { account?: { email?: unknown }; organization?: { uuid?: unknown } };
    return {
      ...(typeof j.account?.email === 'string' ? { email: j.account.email } : {}),
      ...(typeof j.organization?.uuid === 'string' ? { orgId: j.organization.uuid } : {}),
    };
  } catch {
    return null;
  }
};

/** Who the services are signed in as: the login in `.credentials.json`; null without that file or when it cannot be told. */
export async function serviceLogin(exec: Executor, a: Account, home: string, profile: ProfileFetch = fetchProfile): Promise<{ email?: string; orgId?: string } | null> {
  const token = accessToken(await exec.readText(credentialsFile(a, home)));
  return token ? profile(token) : null;
}

/**
 * Copy the account's login from the Keychain into `.credentials.json` (what the services read).
 * Only possible where the Keychain is unlocked (where the sign-in just stored it). False when there
 * is nothing usable to copy.
 */
export async function syncCredentialsFromKeychain(exec: Executor, a: Account, home: string): Promise<boolean> {
  const r = await exec.query('security', ['find-generic-password', '-s', keychainService(a, home), '-w']);
  const secret = r.code === 0 ? r.stdout.trim() : '';
  if (!accessToken(secret)) return false;
  await exec.writeText(credentialsFile(a, home), `${secret}\n`, { mode: 0o600, description: `copy ${a.name}'s login from the Keychain to ${credentialsFile(a, home)}, which its services read` });
  return true;
}
