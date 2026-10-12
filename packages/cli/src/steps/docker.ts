import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { logsDir } from '../config/accounts.js';
import { applyDaemon, checkDaemon, daemonState, serviceEnv, type DaemonSpec } from '../launchd.js';
import { toolPath } from '../state.js';
import { ok, skip, todo, type Step, type StepContext } from './types.js';

export const COLIMA_LABEL = 'com.devhost.colima';
export const CLI_PLUGINS_DIR = '/opt/homebrew/lib/docker/cli-plugins';

export async function colimaSpec(ctx: StepContext): Promise<DaemonSpec> {
  const d = ctx.config.docker;
  const colima = await toolPath(ctx.exec, ctx.home, 'colimaPath', 'colima', '/opt/homebrew/bin/colima');
  return {
    label: COLIMA_LABEL,
    args: [colima, 'start', '--foreground', '--cpu', String(d?.cpu ?? 6), '--memory', String(d?.memoryGiB ?? 16), '--disk', String(d?.diskGiB ?? 200)],
    env: serviceEnv(ctx.home),
    logPath: join(logsDir(ctx.home), 'colima.log'),
  };
}

const wantsColima = (c: DevhostConfig): boolean => c.docker?.runtime === 'colima';

/** Docker CLI plugins installed by Homebrew (compose, buildx) must be on the CLI's search path. */
export const dockerConfigStep: Step = {
  id: 'docker.config',
  description: 'Point the Docker CLI at the Homebrew compose and buildx plugins',
  async check({ config, home, exec }) {
    if (!wantsColima(config)) return skip(`docker.runtime is ${config.docker?.runtime ?? 'none'}`);
    const text = await exec.readText(join(home, '.docker', 'config.json'));
    const dirs = readPluginDirs(text);
    return dirs.includes(CLI_PLUGINS_DIR) ? ok() : todo(`~/.docker/config.json lacks cliPluginsExtraDirs ${CLI_PLUGINS_DIR}`);
  },
  async apply({ home, exec }) {
    const file = join(home, '.docker', 'config.json');
    const text = await exec.readText(file);
    let data: Record<string, unknown> = {};
    if (text !== null && text.trim() !== '') data = JSON.parse(text) as Record<string, unknown>;
    const dirs = readPluginDirs(text);
    data['cliPluginsExtraDirs'] = [...dirs, CLI_PLUGINS_DIR];
    await exec.writeText(file, `${JSON.stringify(data, null, 2)}\n`, { description: `add cliPluginsExtraDirs to ${file}` });
  },
};

function readPluginDirs(text: string | null): string[] {
  if (text === null) return [];
  try {
    const dirs = (JSON.parse(text) as { cliPluginsExtraDirs?: unknown }).cliPluginsExtraDirs;
    return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

export const dockerRuntimeStep: Step = {
  id: 'docker.runtime',
  description: 'Run Colima as a boot-time service with the configured resources',
  async check(ctx) {
    const runtime = ctx.config.docker?.runtime ?? 'none';
    if (runtime === 'none') return skip('docker.runtime is none');
    if (runtime === 'orbstack') {
      ctx.exec.warn('OrbStack needs a GUI login after every reboot; Colima starts at boot without one.');
      return skip('OrbStack is started from its app');
    }
    const daemon = await checkDaemon(ctx, await colimaSpec(ctx));
    if (daemon.state !== 'ok') return daemon;
    const status = await ctx.exec.query('colima', ['status']);
    return status.code === 0 ? ok() : todo('the Colima VM is not running');
  },
  async apply(ctx) {
    // A Colima started by hand would make the service's `colima start` fail.
    const status = await ctx.exec.query('colima', ['status']);
    const spec = await colimaSpec(ctx);
    const state = await daemonState(ctx.exec, spec.label);
    if (status.code === 0 && !state.loaded) {
      await ctx.exec.exec('colima', ['stop'], { reason: 'hand it over to the boot-time service', allowFailure: true });
    }
    await applyDaemon(ctx, spec);
    await ctx.exec.waitFor(async () => (await ctx.exec.query('colima', ['status'])).code === 0, 60, 2000);
  },
};

export const dockerSteps: Step[] = [dockerConfigStep, dockerRuntimeStep];
