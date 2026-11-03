import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { accountRoot, accountsOf, envDir, environmentsOf, rcLabel } from '../config/accounts.js';
import { devhostConfigDir } from '../config/paths.js';
import { daemonInstalled, removeDaemon } from '../launchd.js';
import { reattachLabels } from '../reattach.js';
import { statePath } from '../state.js';
import { UNLOCK_LABEL, passphraseStored, removePassphrase, removeUnlockDaemon, unlockPlistInstalled } from '../storage/root.js';
import { dbPath } from '../collector/db.js';
import { accountArtifactsPresent, removeAccountArtifacts } from './accounts-remove.js';
import { COLLECTOR_LABEL } from './collector.js';
import { COLIMA_LABEL } from './docker.js';
import { gitDir } from './git.js';
import { devhostLabelsOnDisk } from './orphans.js';
import { brewfilePath, requiredPackages } from './packages.js';
import { hashBlock } from './shellblock.js';
import { installed, removeRootHelper } from './root-helper.js';
import { ok, skip, todo, type Step } from './types.js';

export interface UninstallOptions {
  keepPackages: boolean;
  purgeData: boolean;
  /** Also the work volume's unlock service and keychain item; never the volume or its data (spec A13). */
  purgeStorage?: boolean;
}

const labels = (config: DevhostConfig): string[] => [
  COLLECTOR_LABEL,
  ...(config.docker?.runtime === 'colima' ? [COLIMA_LABEL] : []),
  ...environmentsOf(config).map((e) => rcLabel(e.account, e.name)),
];

/** The config's jobs, the reattach jobs and any other com.devhost.* job on disk (removed environments, Colima after a switch); the unlock service only with --purge-storage. */
async function serviceLabels(config: DevhostConfig, opts: UninstallOptions): Promise<string[]> {
  const all = [...labels(config), ...(await reattachLabels()), ...(await devhostLabelsOnDisk())];
  return [...new Set(all)].filter((l) => l !== UNLOCK_LABEL || opts.purgeStorage === true);
}

/**
 * The reverse of `apply`, as steps so --dry-run, events and exit codes work the same way.
 * Never deletes projects, Claude config dirs, credentials, or (without --purge-data) the database.
 */
export function uninstallSteps(config: DevhostConfig, opts: UninstallOptions): Step[] {
  const steps: Step[] = [
    {
      id: 'uninstall.services',
      description: 'Remove devhost\'s launchd jobs (collector, Colima, Remote Control services, session reattaches)',
      async check(ctx) {
        const present: string[] = [];
        for (const l of await serviceLabels(config, opts)) if (await daemonInstalled(ctx.exec, l)) present.push(l);
        return present.length === 0 ? ok() : todo(present.join(', '));
      },
      async apply(ctx) {
        for (const l of await serviceLabels(config, opts)) if (await daemonInstalled(ctx.exec, l)) await removeDaemon(ctx, l);
      },
    },
    {
      id: 'uninstall.helper',
      description: 'Remove the root helper and its sudoers rule',
      async check(ctx) {
        const have = await installed(ctx);
        return have.helper || have.sudoers ? todo('the root helper is installed') : ok();
      },
      apply: (ctx) => removeRootHelper(ctx, 'devhost uninstall'),
    },
    {
      id: 'uninstall.environments',
      description: 'Remove generated .envrc files from environments',
      async check(ctx) {
        for (const e of environmentsOf(config)) {
          const a = accountsOf(config).find((x) => x.name === e.account);
          const text = a ? await ctx.exec.readText(join(envDir(a, e, ctx.home), '.envrc')) : null;
          if (text !== null && text.includes('Managed by devhost')) return todo(`${e.name}/.envrc`);
        }
        return ok();
      },
      async apply(ctx) {
        for (const e of environmentsOf(config)) {
          const a = accountsOf(config).find((x) => x.name === e.account);
          if (!a) continue;
          const file = join(envDir(a, e, ctx.home), '.envrc');
          const text = await ctx.exec.readText(file);
          if (text !== null && text.includes('Managed by devhost')) await ctx.exec.remove(file, { backup: true });
        }
      },
    },
    {
      id: 'uninstall.accounts',
      description: 'Remove devhost-managed settings, CLAUDE.md blocks, .envrc and git identities from accounts',
      async check(ctx) {
        const present: string[] = [];
        for (const a of accountsOf(config)) if (await accountArtifactsPresent(ctx, a, config)) present.push(a.name);
        return present.length === 0 ? ok() : todo(present.join(', '));
      },
      async apply(ctx) {
        for (const a of accountsOf(config)) await removeAccountArtifacts(ctx, a, config);
      },
    },
    {
      id: 'uninstall.shell',
      description: 'Remove the devhost blocks from ~/.zshrc and ~/.gitconfig',
      async check(ctx) {
        const files = ['.zshrc', '.gitconfig'].map((f) => join(ctx.home, f));
        const present: string[] = [];
        for (const f of files) {
          const text = await ctx.exec.readText(f);
          if (text !== null && hashBlock.read(text, f) !== null) present.push(f);
        }
        return present.length === 0 ? ok() : todo(present.join(', '));
      },
      async apply(ctx) {
        for (const f of ['.zshrc', '.gitconfig'].map((x) => join(ctx.home, x))) {
          const text = await ctx.exec.readText(f);
          if (text === null) continue;
          const next = hashBlock.remove(text, f);
          if (next !== text) await ctx.exec.writeText(f, next, { description: `remove the devhost block from ${f}` });
        }
      },
    },
    {
      id: 'uninstall.files',
      description: 'Remove generated files (Brewfile, state, staged plists, git identities); the config stays',
      async check(ctx) {
        for (const f of [brewfilePath(ctx.home), statePath(ctx.home)]) if ((await ctx.exec.readText(f)) !== null) return todo(f);
        for (const d of [join(devhostConfigDir(ctx.home), 'launchd'), gitDir(ctx.home)]) if ((await ctx.exec.query('test', ['-d', d])).code === 0) return todo(d);
        return ok();
      },
      async apply(ctx) {
        await ctx.exec.remove(brewfilePath(ctx.home), { backup: true });
        await ctx.exec.remove(statePath(ctx.home));
        await ctx.exec.remove(join(devhostConfigDir(ctx.home), 'launchd'), { recursive: true });
        await ctx.exec.remove(gitDir(ctx.home), { recursive: true });
      },
    },
  ];

  steps.push(
    opts.keepPackages
      ? { id: 'uninstall.packages', description: 'Uninstall Homebrew packages', check: async () => skip('--keep-packages'), apply: async () => undefined }
      : {
          id: 'uninstall.packages',
          description: 'Uninstall the Homebrew packages devhost installs (formulae and casks from the Brewfile)',
          // Homebrew refuses to remove a formula other packages depend on; that is not a failure.
          verify: false,
          async check(ctx) {
            const { brew, cask } = requiredPackages(config);
            const formulae = new Set((await ctx.exec.query('brew', ['list', '--formula', '-1'])).stdout.split('\n'));
            const casks = new Set((await ctx.exec.query('brew', ['list', '--cask', '-1'])).stdout.split('\n'));
            const present = [...brew.filter((b) => formulae.has(b)), ...cask.filter((c) => casks.has(c))];
            return present.length === 0 ? ok() : todo(present.join(', '));
          },
          async apply(ctx) {
            const { brew, cask } = requiredPackages(config);
            const formulae = new Set((await ctx.exec.query('brew', ['list', '--formula', '-1'])).stdout.split('\n'));
            const casks = new Set((await ctx.exec.query('brew', ['list', '--cask', '-1'])).stdout.split('\n'));
            for (const b of brew.filter((x) => formulae.has(x))) await ctx.exec.exec('brew', ['uninstall', '--formula', b], { allowFailure: true });
            for (const c of cask.filter((x) => casks.has(x))) await ctx.exec.exec('brew', ['uninstall', '--cask', c], { allowFailure: true });
          },
        },
  );

  if (opts.purgeStorage) {
    steps.push({
      id: 'uninstall.storage',
      description: "Remove the work volume's unlock service and passphrase (--purge-storage; the volume and its data stay)",
      async check(ctx) {
        return (await unlockPlistInstalled(ctx.exec)) || (await passphraseStored(ctx.exec)) ? todo('unlock service or keychain item present') : ok();
      },
      async apply(ctx) {
        await removeUnlockDaemon(ctx.exec);
        await removePassphrase(ctx.exec);
      },
    });
  }

  if (opts.purgeData) {
    steps.push({
      id: 'uninstall.data',
      description: 'Delete the collector database (--purge-data)',
      async check(ctx) {
        return (await ctx.exec.query('test', ['-d', join(dbPath(ctx.home), '..')])).code === 0 ? todo(dbPath(ctx.home)) : ok();
      },
      async apply(ctx) {
        await ctx.exec.remove(join(dbPath(ctx.home), '..'), { recursive: true });
      },
    });
  }
  return steps;
}

export function keptByUninstall(config: DevhostConfig, home: string, opts: UninstallOptions): string[] {
  return [
    ...environmentsOf(config).flatMap((e) => {
      const a = accountsOf(config).find((x) => x.name === e.account);
      return a ? [envDir(a, e, home)] : [];
    }),
    ...accountsOf(config).flatMap((a) => [accountRoot(a, home), a.configDir ?? '~/.claude']),
    'credentials (Keychain or .credentials.json)',
    ...(opts.purgeData ? [] : [dbPath(home)]),
    join(devhostConfigDir(home), 'config.yaml'),
    'hostname, power and Remote Login settings, Tailscale, Colima VM data, mise runtimes',
    ...(config.storage?.workVolume ? [`the work volume ${config.storage.workVolume.label} and everything on it${opts.purgeStorage ? '' : ', its unlock service and keychain item (--purge-storage removes those two)'}`] : []),
  ];
}
