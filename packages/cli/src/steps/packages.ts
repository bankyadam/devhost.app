import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { devhostConfigDir } from '../config/paths.js';
import { renderTemplate } from '../render.js';
import { ok, todo, type Step } from './types.js';

export function brewfilePath(home: string): string {
  return join(devhostConfigDir(home), 'Brewfile');
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Everything devhost needs installed: the user's list plus what the configured
 * features require (mise for runtimes, direnv for accounts, a Docker runtime,
 * Tailscale, Claude Code).
 */
export function requiredPackages(config: DevhostConfig): { brew: string[]; cask: string[] } {
  const brew = [...(config.packages?.brew ?? [])];
  const cask = [...(config.packages?.cask ?? [])];
  if (Object.keys(config.runtimes ?? {}).length > 0) brew.push('mise');
  if ((config.accounts ?? []).length > 0) brew.push('direnv');
  if (config.docker?.runtime === 'colima') brew.push('colima', 'docker', 'docker-compose', 'docker-buildx');
  if (config.docker?.runtime === 'orbstack') cask.push('orbstack');
  if (config.network?.tailscale) brew.push('tailscale');
  if (config.claude?.install === 'brew') cask.push('claude-code');
  return { brew: unique(brew), cask: unique(cask) };
}

export const brewFormulae = (config: DevhostConfig): string[] => requiredPackages(config).brew;

export async function renderBrewfile(config: DevhostConfig): Promise<string> {
  return renderTemplate('Brewfile', {
    brew: requiredPackages(config).brew,
    cask: requiredPackages(config).cask,
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
