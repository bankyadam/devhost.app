import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { devhostConfigDir } from '../config/paths.js';
import { renderTemplate } from '../render.js';
import { ok, todo, type Step } from './types.js';

export function brewfilePath(home: string): string {
  return join(devhostConfigDir(home), 'Brewfile');
}

/** brew formulae from the config; mise is added when runtimes are requested. */
export function brewFormulae(config: DevhostConfig): string[] {
  const brew = [...(config.packages?.brew ?? [])];
  const wantsRuntimes = Object.keys(config.runtimes ?? {}).length > 0;
  if (wantsRuntimes && !brew.includes('mise')) brew.push('mise');
  return brew;
}

export async function renderBrewfile(config: DevhostConfig): Promise<string> {
  return renderTemplate('Brewfile', {
    brew: brewFormulae(config),
    cask: config.packages?.cask ?? [],
    extra: config.packages?.extra ?? [],
  });
}

export const packagesStep: Step = {
  id: 'packages',
  description: 'Render the Brewfile and run brew bundle',
  async check({ config, home, exec }) {
    const path = brewfilePath(home);
    const want = await renderBrewfile(config);
    const have = await exec.readText(path);
    if (have !== want) return todo(have === null ? `${path} does not exist yet` : `${path} is out of date`);
    const r = await exec.query('brew', ['bundle', 'check', `--file=${path}`]);
    if (r.code === 127) return todo('Homebrew is not installed (run bootstrap.sh)');
    return r.code === 0 ? ok() : todo('some Brewfile entries are not installed');
  },
  async apply({ config, home, exec }) {
    const path = brewfilePath(home);
    const want = await renderBrewfile(config);
    if ((await exec.readText(path)) !== want) {
      await exec.writeText(path, want, { description: `write ${path}` });
    }
    await exec.exec('brew', ['bundle', `--file=${path}`], {
      env: { HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1' },
    });
  },
};
