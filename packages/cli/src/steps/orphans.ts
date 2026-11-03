import { readdir } from 'node:fs/promises';
import type { DevhostConfig } from '@devhost/contract';
import { environmentsOf, rcLabel } from '../config/accounts.js';
import { HumanActionRequired } from '../errors.js';
import { launchDaemonsDir, removeDaemon } from '../launchd.js';
import { REATTACH_PREFIX } from '../reattach.js';
import { UNLOCK_LABEL } from '../storage/root.js';
import { COLLECTOR_LABEL } from './collector.js';
import { COLIMA_LABEL } from './docker.js';
import { ok, todo, type Step } from './types.js';

/** The launchd labels this config asks for (reattach jobs and the unlock service have their own owners). */
export const wantedLabels = (config: DevhostConfig): string[] => [
  COLLECTOR_LABEL,
  UNLOCK_LABEL,
  ...(config.docker?.runtime === 'colima' ? [COLIMA_LABEL] : []),
  ...environmentsOf(config).map((e) => rcLabel(e.account, e.name)),
];

/** Every com.devhost.* job on disk, whatever the config says. */
export async function devhostLabelsOnDisk(): Promise<string[]> {
  try {
    return (await readdir(launchDaemonsDir())).filter((f) => f.startsWith('com.devhost.') && f.endsWith('.plist')).map((f) => f.slice(0, -'.plist'.length)).sort();
  } catch {
    return [];
  }
}

/** Jobs of removed environments, or of Colima after a runtime switch: nothing in the config wants them. */
export async function orphanLabels(config: DevhostConfig): Promise<string[]> {
  const wanted = new Set(wantedLabels(config));
  return (await devhostLabelsOnDisk()).filter((l) => !wanted.has(l) && !l.startsWith(REATTACH_PREFIX));
}

export const orphansStep: Step = {
  id: 'services.orphans',
  description: 'Remove devhost services that nothing in the config asks for any more',
  async check(ctx) {
    const found = await orphanLabels(ctx.config);
    return found.length === 0 ? ok() : todo(`not in the config: ${found.join(', ')}`);
  },
  async apply(ctx) {
    const found = await orphanLabels(ctx.config);
    if (found.length === 0) return;
    if (!ctx.exec.dryRun) {
      if (!ctx.confirm) throw new HumanActionRequired(`devhost services that the config does not ask for: ${found.join(', ')}`, 'Run `devhost apply --yes` to remove them.');
      if (!(await ctx.confirm('remove-orphan-services', `Remove services the config no longer asks for (${found.join(', ')})?`))) {
        throw new HumanActionRequired(`left in place: ${found.join(', ')}`, 'Run `devhost apply --yes` to remove them.');
      }
    }
    for (const l of found) await removeDaemon(ctx, l);
  },
};
