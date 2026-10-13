import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { accountsOf, claudeConfigDir } from '../config/accounts.js';
import { shellQuote } from './routing.js';
import { hashBlock } from './shellblock.js';
import { ok, todo, type Step } from './types.js';

/**
 * Body of the managed ~/.zshrc block. Later phases add the direnv hook and
 * the claude-<account> aliases here; everything shares one block.
 */
export function shellBlockBody(config: DevhostConfig, home: string, brewPrefix: string): string[] {
  const body = [
    '# Managed by devhost. Change ~/.config/devhost/config.yaml and run `devhost apply`.',
    `[ -x ${brewPrefix}/bin/brew ] && eval "$(${brewPrefix}/bin/brew shellenv)"`,
  ];
  if (Object.keys(config.runtimes ?? {}).length > 0) {
    body.push('command -v mise >/dev/null 2>&1 && eval "$(mise activate zsh)"');
  }
  const accounts = accountsOf(config);
  if (accounts.length > 0) {
    body.push('command -v direnv >/dev/null 2>&1 && eval "$(direnv hook zsh)"');
    for (const a of accounts) {
      const dir = claudeConfigDir(a, home);
      body.push(
        dir
          ? `alias claude-${a.name}='CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude'`
          : `alias claude-${a.name}='env -u CLAUDE_CONFIG_DIR claude'`,
      );
    }
  }
  return body;
}

export const shellStep: Step = {
  id: 'shell',
  description: 'Maintain the managed block in ~/.zshrc',
  async check({ config, home, brewPrefix, exec }) {
    const file = join(home, '.zshrc');
    const text = (await exec.readText(file)) ?? '';
    const current = hashBlock.read(text, file);
    const want = shellBlockBody(config, home, brewPrefix);
    if (current === null) return todo('the devhost block is missing');
    return current.join('\n') === want.join('\n') ? ok() : todo('the devhost block is out of date');
  },
  async apply({ config, home, brewPrefix, exec }) {
    const file = join(home, '.zshrc');
    const text = (await exec.readText(file)) ?? '';
    await exec.writeText(file, hashBlock.upsert(text, shellBlockBody(config, home, brewPrefix), file), {
      description: `update the devhost block in ${file}`,
    });
  },
};
