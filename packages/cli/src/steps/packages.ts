import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { devhostConfigDir } from '../config/paths.js';
import { CommandError, DevhostError } from '../errors.js';
import { renderTemplate } from '../render.js';
import { ok, todo, type Step } from './types.js';

export function brewfilePath(home: string): string {
  return join(devhostConfigDir(home), 'Brewfile');
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

const BREW_ENV = { HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1' };

/**
 * `brew bundle check` without `--no-upgrade` also fails on merely outdated packages, and
 * `brew bundle` upgrades them: every apply then upgraded (on Intel, rebuilt from source) whatever
 * had a new release. devhost only makes sure the packages are there; upgrading stays `brew upgrade`
 * (Claude Code's minimum version is the `claude` step's job). No auto-update just to check.
 */
export const bundleCheckArgs = (file: string): string[] => ['bundle', 'check', '--no-upgrade', `--file=${file}`];
export const BUNDLE_CHECK_ENV = { ...BREW_ENV, HOMEBREW_NO_AUTO_UPDATE: '1' };

/**
 * Everything devhost needs installed: the user's list plus what the configured
 * features require (direnv for accounts, a Docker runtime, Tailscale, Claude Code).
 * mise is not among them: the runtimes step installs it with its own installer (see mise.ts).
 */
export function requiredPackages(config: DevhostConfig): { brew: string[]; cask: string[] } {
  const brew = [...(config.packages?.brew ?? [])];
  const cask = [...(config.packages?.cask ?? [])];
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
    const r = await exec.query('brew', bundleCheckArgs(path), { env: BUNDLE_CHECK_ENV });
    if (r.code === 127) return todo('Homebrew is not installed (run bootstrap.sh)');
    return r.code === 0 ? ok() : todo('some Brewfile entries are not installed');
  },
  async apply({ config, home, exec }) {
    const path = brewfilePath(home);
    const want = await renderBrewfile(config);
    if ((await exec.readText(path)) !== want) {
      await exec.writeText(path, want, { description: `write ${path}` });
    }
    try {
      await exec.exec('brew', ['bundle', 'install', '--no-upgrade', `--file=${path}`], { env: BREW_ENV, progress: true });
    } catch (err) {
      // brew bundle only says "Installing tmux has failed!"; the reason is in brew install's own output.
      const failed = err instanceof CommandError ? /Installing (\S+) has failed/.exec(err.stderr)?.[1] : undefined;
      if (!(err instanceof CommandError) || !failed) throw err;
      throw new DevhostError(err.message, 'command-failed', undefined, `Run \`brew install ${failed}\` to see why it fails, fix that, then \`devhost apply\` again.`);
    }
  },
};
