import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { managedSettings, parseSettings, removeManaged, stringifySettings } from '../claude-settings.js';
import { accountRoot, claudeConfigDir, type Account } from '../config/accounts.js';
import { ENVRC_HEADER } from './routing.js';
import { accountGitConfigPath } from './git.js';
import { claudeMdPathOf, settingsPathOf } from './claude.js';
import { markdownBlock } from './shellblock.js';
import type { StepContext } from './types.js';

/**
 * Undo what the account-scoped steps wrote for `a`. Never touches the account root,
 * the Claude config dir itself, or credentials (spec A7.11). Returns what was kept.
 */
export async function removeAccountArtifacts(ctx: StepContext, a: Account, config: DevhostConfig): Promise<string[]> {
  const { exec, home } = ctx;

  const envrc = join(accountRoot(a, home), '.envrc');
  const envrcText = await exec.readText(envrc);
  if (envrcText !== null && envrcText.startsWith(ENVRC_HEADER)) await exec.remove(envrc, { backup: true });

  const settingsFile = settingsPathOf(a, home);
  const settingsText = await exec.readText(settingsFile);
  if (settingsText !== null) {
    const next = removeManaged(parseSettings(settingsText, settingsFile), managedSettings(config, a), config.collector?.port ?? 4318);
    if (stringifySettings(next) !== settingsText) {
      await exec.writeText(settingsFile, stringifySettings(next), { description: `remove devhost-managed keys from ${settingsFile}` });
    }
  }

  const mdFile = claudeMdPathOf(a, home);
  const md = await exec.readText(mdFile);
  if (md !== null) {
    const next = markdownBlock.remove(md, mdFile);
    if (next !== md) await exec.writeText(mdFile, next, { description: `remove the devhost block from ${mdFile}` });
  }

  await exec.remove(accountGitConfigPath(home, a.name));

  return [accountRoot(a, home), claudeConfigDir(a, home) ?? join(home, '.claude'), 'credentials (Keychain or .credentials.json)'];
}

/** True when `removeAccountArtifacts` would change anything for this account. */
export async function accountArtifactsPresent(ctx: StepContext, a: Account, config: DevhostConfig): Promise<boolean> {
  const { exec, home } = ctx;
  const envrc = await exec.readText(join(accountRoot(a, home), '.envrc'));
  if (envrc !== null && envrc.startsWith(ENVRC_HEADER)) return true;
  const settingsFile = settingsPathOf(a, home);
  const settings = await exec.readText(settingsFile);
  if (settings !== null) {
    try {
      const next = removeManaged(parseSettings(settings, settingsFile), managedSettings(config, a), config.collector?.port ?? 4318);
      if (stringifySettings(next) !== settings) return true;
    } catch {
      /* an unreadable settings.json is left alone */
    }
  }
  const md = await exec.readText(claudeMdPathOf(a, home));
  if (md !== null && markdownBlock.read(md) !== null) return true;
  return (await exec.readText(accountGitConfigPath(home, a.name))) !== null;
}
