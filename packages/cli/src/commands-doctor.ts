import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import type { DoctorData, StatusData } from '@devhost/contract';
import { runSteps } from './apply.js';
import { Db, dbPath } from './collector/db.js';
import { long, newExecutor, newReporter, newStepContext, short, type GlobalOptions } from './command-support.js';
import { accountsOf, environmentsOf, rcLabel } from './config/accounts.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { formatApplySummary, cliVersion } from './commands.js';
import { daemonInstalled, daemonState } from './launchd.js';
import { authStatus } from './login.js';
import { makePrompter } from './prompter.js';
import { runDoctor, type Check } from './doctor/checks.js';
import { COLLECTOR_LABEL } from './steps/collector.js';
import { parseTailscale } from './steps/tailscale.js';
import { keptByUninstall, uninstallSteps, type UninstallOptions } from './steps/uninstall.js';
import { requiredPackages } from './steps/packages.js';

const SYMBOL = { ok: '✅', warn: '⚠️ ', fail: '❌' } as const;

export function formatDoctor(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${SYMBOL[c.status]} ${c.id} — ${c.message}`);
    if (c.fix && c.status !== 'ok') lines.push(`     fix: ${c.fix}`);
  }
  const n = (s: Check['status']): number => checks.filter((c) => c.status === s).length;
  lines.push('', `${n('ok')} ok, ${n('warn')} warnings, ${n('fail')} failed`);
  return lines.join('\n');
}

/** Read-only checks with one-line fixes; exit 1 when anything failed (spec A11, A12). */
export function doctorCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<DoctorData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const checks = await runDoctor({ deps, config, configPath: g.configPath, exec, now: deps.now().getTime() });
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status]++;
    return { data: { ok: summary.fail === 0, summary, checks }, human: formatDoctor(checks), exit: summary.fail === 0 ? 0 : 1 };
  });
}

/** One-screen summary. */
export function statusCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<StatusData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, newReporter(deps, g), false);

    let tailscale: StatusData['host']['tailscale'] = null;
    if (config.network?.tailscale) {
      const r = await exec.query('tailscale', ['status', '--json']);
      const st = r.code === 0 ? parseTailscale(r.stdout) : null;
      if (st?.BackendState) tailscale = { state: st.BackendState, dnsName: st.Self?.DNSName?.replace(/\.$/, '') ?? null, ips: st.Self?.TailscaleIPs ?? [] };
    }
    const accounts: StatusData['accounts'] = [];
    for (const a of accountsOf(config)) accounts.push({ name: a.name, default: a.default === true, loggedIn: (await authStatus({ exec, deps }, a)).loggedIn });

    const environments: StatusData['environments'] = [];
    for (const e of environmentsOf(config)) {
      const label = rcLabel(e.account, e.name);
      const state = e.remoteControl?.enabled === false ? 'disabled' : (await daemonState(exec, label)).running ? 'running' : (await daemonInstalled(exec, label)) ? 'stopped' : 'not-installed';
      environments.push({ account: e.account, name: e.name, service: state, portBase: e.portBase ?? null });
    }

    let lastSampleAt: number | null = null;
    const path = dbPath(deps.home);
    if (existsSync(path)) {
      const db = new Db(path, { readonly: true });
      try {
        lastSampleAt = db.get<{ ts: number }>('SELECT MAX(ts) AS ts FROM samples_system')?.ts ?? null;
      } finally {
        db.close();
      }
    }
    const dockerUsed = (config.docker?.runtime ?? 'none') !== 'none';
    const docker: StatusData['docker'] = !dockerUsed ? 'not-used' : (await exec.query('docker', ['info', '--format', '{{.ServerVersion}}'])).code === 0 ? 'up' : 'down';
    const df = (await exec.query('df', ['-k', '/'])).stdout.trim().split('\n')[1]?.trim().split(/\s+/);
    const diskFreePercent = df && Number(df[1]) > 0 ? (Number(df[3]) / Number(df[1])) * 100 : null;
    const collectorRunning = (await daemonState(exec, COLLECTOR_LABEL)).running;

    const data: StatusData = { version: cliVersion(), host: { name: hostname(), tailscale }, accounts, environments, collector: { running: collectorRunning, lastSampleAt }, docker, diskFreePercent };
    const ago = lastSampleAt === null ? 'no data yet' : `last sample ${Math.max(0, Math.round((deps.now().getTime() - lastSampleAt) / 1000))}s ago`;
    const human = [
      `devhost ${data.version} on ${data.host.name}${tailscale ? `  (tailscale ${tailscale.state}${tailscale.dnsName ? `: ${tailscale.dnsName}` : ''}${tailscale.ips[0] ? `, ${tailscale.ips[0]}` : ''})` : ''}`,
      accounts.length === 0 ? 'Accounts:     none yet (devhost account add ...)' : `Accounts:     ${accounts.map((a) => `${a.name}${a.default ? ' (default)' : ''} ${a.loggedIn === null ? '?' : a.loggedIn ? 'logged in' : 'NOT logged in'}`).join(', ')}`,
      environments.length === 0 ? 'Environments:  none yet' : `Environments:  ${environments.map((e) => `${e.account}/${e.name} ${e.service}`).join(', ')}`,
      `Collector:    ${collectorRunning ? 'running' : 'NOT running'}, ${ago}`,
      `Docker:       ${docker}    Disk free: ${diskFreePercent === null ? '?' : `${diskFreePercent.toFixed(0)}%`}`,
      'Details and fixes: devhost doctor    Live view: devhost top',
    ].join('\n');
    return { data, human };
  });
}

export interface UninstallCommandOptions extends UninstallOptions {
  dryRun: boolean;
}

export function uninstallCommand(deps: Deps, g: GlobalOptions, opts: UninstallCommandOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, reporter, opts.dryRun);
    const steps = uninstallSteps(config, opts);
    const kept = keptByUninstall(config, deps.home, opts);

    if (!opts.dryRun) {
      const prompter = makePrompter(deps, g.json, g.yes);
      if (!(await prompter.confirm('confirm-uninstall', 'Remove devhost\'s services, shell/git blocks and generated files? Projects, Claude config dirs and credentials stay.'))) {
        return { ok: false, data: { dryRun: false, changed: false, steps: [], plan: [], kept }, human: ['Nothing was changed.'] };
      }
      if (!opts.keepPackages) {
        const { brew, cask } = requiredPackages(config);
        const list = [...brew, ...cask.map((c) => `${c} (cask)`)].join(', ');
        if (!(await prompter.confirm('confirm-packages', `Also uninstall these Homebrew packages: ${list}? Use --keep-packages to keep them.`))) {
          steps.splice(steps.findIndex((s) => s.id === 'uninstall.packages'), 1);
          kept.push('Homebrew packages');
        }
      }
    }

    const outcome = await runSteps(steps, newStepContext(deps, g, config, exec), reporter, deps.cancel);
    const data = { ...outcome.data, kept };
    const human = [...formatApplySummary(data).map((l) => l.replace('Done: changes were applied.', 'Done.').replace('No changes: the system already matches the config.', 'Nothing to remove.')), '', `Kept: ${kept.join('; ')}`];
    if (!opts.purgeData) human.push('The collector database stays; add --purge-data to delete it.');
    return { ok: outcome.error === null, data, error: outcome.error, cancelled: outcome.cancelled, human };
  });
}
