import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { readBlock, upsertBlock } from './shellblock.js';
import { ok, todo, type Step } from './types.js';

/**
 * Body of the managed ~/.zshrc block. Later phases add the direnv hook and
 * the claude-<account> aliases here; everything shares one block.
 */
export function shellBlockBody(config: DevhostConfig): string[] {
  const body = [
    '# Managed by devhost. Change ~/.config/devhost/config.yaml and run `devhost apply`.',
    '[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"',
  ];
  if (Object.keys(config.runtimes ?? {}).length > 0) {
    body.push('command -v mise >/dev/null 2>&1 && eval "$(mise activate zsh)"');
  }
  return body;
}

export const shellStep: Step = {
  id: 'shell',
  description: 'Maintain the managed block in ~/.zshrc',
  async check({ config, home, exec }) {
    const file = join(home, '.zshrc');
    const text = (await exec.readText(file)) ?? '';
    const current = readBlock(text, file);
    const want = shellBlockBody(config);
    if (current === null) return todo('the devhost block is missing');
    return current.join('\n') === want.join('\n') ? ok() : todo('the devhost block is out of date');
  },
  async apply({ config, home, exec }) {
    const file = join(home, '.zshrc');
    const text = (await exec.readText(file)) ?? '';
    await exec.writeText(file, upsertBlock(text, shellBlockBody(config), file), {
      description: `update the devhost block in ${file}`,
    });
  },
};
