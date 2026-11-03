import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logsDir } from '../config/accounts.js';
import { dbPath } from '../collector/db.js';
import { applyDaemon, checkDaemon, serviceEnv, type DaemonSpec } from '../launchd.js';
import type { Step, StepContext } from './types.js';

export const COLLECTOR_LABEL = 'com.devhost.collector';

export async function collectorSpec(ctx: StepContext): Promise<DaemonSpec> {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  return {
    label: COLLECTOR_LABEL,
    // node:sqlite prints an ExperimentalWarning on every start; keep the log readable.
    args: [ctx.nodePath, '--disable-warning=ExperimentalWarning', cli, 'collector', 'run', '--config', ctx.configPath],
    // The settings only the collector process reads (port, intervals, thresholds, notifications) go in
    // the plist as a hash, so a change makes `apply` rewrite it and restart the collector.
    env: serviceEnv(ctx.home, { DEVHOST_COLLECTOR_SETTINGS: createHash('sha256').update(JSON.stringify(ctx.config.collector ?? {})).digest('hex').slice(0, 16) }),
    logPath: join(logsDir(ctx.home), 'collector.log'),
  };
}

/** The one long-running process devhost adds (spec A5, A10): a boot-time LaunchDaemon. */
export const collectorStep: Step = {
  id: 'collector',
  description: 'Run the collector (telemetry, samplers, alerts) as a boot-time service',
  async check(ctx) {
    return checkDaemon(ctx, await collectorSpec(ctx));
  },
  async apply(ctx) {
    await ctx.exec.mkdirp(join(dbPath(ctx.home), '..'), { mode: 0o700 });
    await applyDaemon(ctx, await collectorSpec(ctx));
  },
};
