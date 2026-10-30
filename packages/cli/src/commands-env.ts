import { open, readFile, stat } from 'node:fs/promises';
import type { DevhostConfig, EnvChangeData, EnvListData, EnvLogsData } from '@devhost/contract';
import { runSteps } from './apply.js';
import { long, newExecutor, newReporter, newStepContext, short, type GlobalOptions } from './command-support.js';
import { withPortBases } from './commands.js';
import { composeProject, envDir, environmentsOf, findAccount, rcLabel, rcLogPath, type Account, type Environment } from './config/accounts.js';
import { appendTo, editConfigFile, removeFrom } from './config/edit.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';
import { bootstrapDaemon, daemonInstalled, daemonState, plistPath, removeDaemon, stopDaemon } from './launchd.js';
import { acceptWorkspace, authStatus, type LoginContext } from './login.js';
import { allocatePortBase } from './ports.js';
import { makePrompter } from './prompter.js';
import type { Executor } from './runner/executor.js';
import { sleepEnv, wakeEnv } from './sleep.js';
import { buildSteps, selectSteps } from './steps/index.js';

function findEnv(config: DevhostConfig, name: string): { env: Environment; account: Account } {
  const env = environmentsOf(config).find((e) => e.name === name);
  if (!env) throw new UsageError(`no environment named "${name}"`, 'See `devhost env list`.');
  const account = findAccount(config, env.account);
  if (!account) throw new UsageError(`environment "${name}" refers to the unknown account "${env.account}"`);
  return { env, account };
}

/** Log tail searched for the environment link; the service prints it on every (re)connect. */
const URL_TAIL_BYTES = 64 * 1024;
const ENV_URL = /https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9]+/g;

/** The claude.ai/code link of an environment's Remote Control environment, the last one its service logged. */
export async function environmentUrl(logPath: string): Promise<{ url?: string }> {
  try {
    const handle = await open(logPath, 'r');
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, URL_TAIL_BYTES);
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
      const url = buffer.toString('utf8').match(ENV_URL)?.at(-1);
      return url ? { url } : {};
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
}

async function serviceInfo(exec: Executor, env: Environment): Promise<EnvListData['environments'][number]['service']> {
  const label = rcLabel(env.account, env.name);
  if (env.remoteControl?.enabled === false) return { label, state: 'disabled', pid: null };
  const st = await daemonState(exec, label);
  if (st.running) return { label, state: 'running', pid: st.pid };
  return { label, state: (await daemonInstalled(exec, label)) ? 'stopped' : 'not-installed', pid: null };
}

export function envListCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<EnvListData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const environments: EnvListData['environments'] = [];
    for (const e of environmentsOf(config)) {
      const a = findAccount(config, e.account);
      if (!a) continue;
      const dir = envDir(a, e, deps.home);
      environments.push({
        name: e.name,
        account: e.account,
        dir,
        dirExists: (await exec.query('test', ['-d', dir])).code === 0,
        portBase: e.portBase ?? null,
        remoteControl: { enabled: e.remoteControl?.enabled !== false, spawn: e.remoteControl?.spawn ?? 'worktree', permissionMode: e.remoteControl?.permissionMode ?? 'acceptEdits', ...(await environmentUrl(rcLogPath(deps.home, e.account, e.name))) },
        compose: e.compose ?? 'auto',
        service: await serviceInfo(exec, e),
      });
    }
    const human =
      environments.length === 0
        ? 'No environments yet. Create one with `devhost env create --account <a> --name <n> [--repo <url>]`.'
        : ['NAME\tACCOUNT\tPORTS\tSERVICE\tDIR', ...environments.map((e) => [e.name, e.account, e.portBase === null ? '-' : `${e.portBase}-${e.portBase + 99}`, e.service.state, e.dir].join('\t'))].join('\n');
    return { data: { environments }, human };
  });
}

export interface EnvCreateOptions {
  account: string;
  name: string;
  repo?: string;
  noRc: boolean;
  compose: 'auto' | 'off';
  spawn?: string;
  permissionMode?: string;
}

export function envCreateCommand(deps: Deps, g: GlobalOptions, opts: EnvCreateOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const loaded = await loadConfig(g.configPath);
    const account = findAccount(loaded.config, opts.account);
    if (!account) {
      throw new UsageError(`account "${opts.account}" does not exist`, `Add it first: devhost account add --name ${opts.account} --git-email <email>`);
    }
    // Re-running create for an environment that is already in the config continues its setup (e.g. after
    // the sudo step stopped it), as long as it names the same account and repo; the config's settings win.
    const existing = environmentsOf(loaded.config).find((e) => e.name === opts.name);
    if (existing) {
      const differs = [
        ...(existing.account !== opts.account ? [`account ${existing.account}`] : []),
        ...(opts.repo !== undefined && existing.repo !== opts.repo ? [`repo ${existing.repo ?? '(none)'}`] : []),
      ];
      if (differs.length > 0) {
        throw new UsageError(`environment "${opts.name}" already exists with ${differs.join(' and ')}`, `Use another name, or remove it first: devhost env delete ${opts.name}`);
      }
    }

    let config = loaded.config;
    let portBase: number;
    let rcEnabled: boolean;
    if (existing) {
      // A hand-written entry may lack its port block; apply allocates and writes missing ones.
      if (existing.portBase === undefined) config = await withPortBases(config, g, deps, newExecutor(deps, g, reporter, false));
      portBase = environmentsOf(config).find((e) => e.name === opts.name)!.portBase!;
      rcEnabled = existing.remoteControl?.enabled !== false;
      reporter.step('config', 'ok', `already in ${g.configPath}; continuing its setup with the settings there`);
    } else {
      portBase = allocatePortBase(loaded.config, account);
      rcEnabled = !opts.noRc;
      const entry = {
        name: opts.name,
        account: opts.account,
        ...(opts.repo ? { repo: opts.repo } : {}),
        portBase,
        remoteControl: { enabled: rcEnabled, spawn: opts.spawn ?? 'worktree', permissionMode: opts.permissionMode ?? 'acceptEdits' },
        compose: opts.compose,
      };
      reporter.step('config', 'start', `add environment ${opts.name} to ${g.configPath}`);
      ({ config } = await editConfigFile(g.configPath, deps.now(), (doc) => appendTo(doc, 'environments', entry)));
      reporter.step('config', 'changed', `port block ${portBase}-${portBase + 99}`);
    }

    const exec = newExecutor(deps, g, reporter, false);
    const prompter = makePrompter(deps, g.json, g.yes);
    const loggedIn = (await authStatus({ exec, deps }, account)).loggedIn;
    if (rcEnabled && loggedIn !== true) {
      exec.warn(`Account "${opts.account}" is not logged in, so workspace trust was not accepted. Run \`devhost login ${opts.account}\`.`);
    }
    const loginCtx: LoginContext = {
      deps,
      config,
      account,
      exec,
      reporter,
      prompter,
      interactive: deps.stdinIsTTY && !g.json,
      idleMs: Number(deps.env['DEVHOST_TRUST_IDLE_MS']) || undefined,
      answerAfterMs: deps.env['DEVHOST_TRUST_ANSWER_MS'] === undefined ? undefined : Number(deps.env['DEVHOST_TRUST_ANSWER_MS']),
      stepContext: () => newStepContext(deps, g, config, exec),
    };
    const ctx = newStepContext(deps, g, config, exec, {
      beforeService: async (info) => {
        if (loggedIn !== true) return;
        reporter.step(`trust.${info.name}`, 'start', info.dir);
        const ok = await acceptWorkspace(loginCtx, info);
        reporter.step(`trust.${info.name}`, ok ? 'ok' : 'skipped', ok ? undefined : 'not trusted (declined, or Claude Code stopped before asking); the service will exit until it is');
      },
    });
    const outcome = await runSteps(selectSteps(buildSteps(config), [`env.${opts.name}`]), ctx, reporter, deps.cancel);
    const dir = envDir(account, { name: opts.name } as Environment, deps.home);
    const data: EnvChangeData = {
      name: opts.name,
      account: opts.account,
      action: 'created',
      dir,
      portBase,
      steps: outcome.data.steps.map(({ id, status, message }) => ({ id, status, ...(message ? { message } : {}) })),
      ...(exec.warnings.length > 0 ? { warnings: exec.warnings } : {}),
    };
    return {
      ok: outcome.error === null,
      data,
      error: outcome.error,
      cancelled: outcome.cancelled,
      human: outcome.error || outcome.cancelled ? [] : ['', `✅ Environment ${opts.account}/${opts.name} ready in ${dir} (ports ${portBase}-${portBase + 99}).`],
    };
  });
}

async function unpushedWork(exec: Executor, dir: string): Promise<{ commits: string[]; uncommitted: boolean }> {
  const log = await exec.query('git', ['-C', dir, 'log', '--branches', '--not', '--remotes', '--oneline']);
  const status = await exec.query('git', ['-C', dir, 'status', '--porcelain']);
  return { commits: log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [], uncommitted: status.code === 0 && status.stdout.trim() !== '' };
}

export interface EnvDeleteOptions {
  deleteFiles: boolean;
  confirmName?: string;
}

export function envDeleteCommand(deps: Deps, g: GlobalOptions, name: string, opts: EnvDeleteOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const loaded = await loadConfig(g.configPath);
    const { env, account } = findEnv(loaded.config, name);
    const dir = envDir(account, env, deps.home);
    const exec = newExecutor(deps, g, reporter, false);
    const dirExists = (await exec.query('test', ['-d', dir])).code === 0;
    const unpushed = dirExists ? await unpushedWork(exec, dir) : { commits: [], uncommitted: false };

    if (opts.deleteFiles && dirExists) {
      reporter.log('warn', `--delete-files will remove ${dir}`);
      if (unpushed.commits.length > 0) reporter.log('warn', `Unpushed commits:\n  ${unpushed.commits.join('\n  ')}`);
      if (unpushed.uncommitted) reporter.log('warn', 'There are uncommitted changes.');
      const typed = opts.confirmName ?? (await makePrompter(deps, g.json, false).input('confirm-name', `Type the environment name "${name}" to delete its files:`));
      if (typed !== name) throw new UsageError('the typed name does not match; nothing was deleted');
    } else if (!(await makePrompter(deps, g.json, g.yes).confirm('confirm-delete', `Stop and remove environment ${account.name}/${name}? Files stay on disk.`))) {
      throw new UsageError('cancelled; nothing was deleted');
    }

    const ctx = newStepContext(deps, g, loaded.config, exec);
    exec.beginStep(`env.${name}`);
    reporter.step(`env.${name}`, 'start', 'stop services');
    if (dirExists) {
      await exec.exec('docker', ['compose', '-p', composeProject(name), 'down'], { cwd: dir, allowFailure: true, reason: 'stop compose services' });
    }
    await removeDaemon(ctx, rcLabel(account.name, name));
    reporter.step(`env.${name}`, 'changed', 'service removed');

    await editConfigFile(g.configPath, deps.now(), (doc) => removeFrom(doc, 'environments', (e) => e['name'] === name));
    reporter.step('config', 'changed', `removed ${name}`);

    let filesDeleted = false;
    if (opts.deleteFiles && dirExists) {
      await exec.remove(dir, { recursive: true });
      filesDeleted = true;
      reporter.step('files', 'changed', `deleted ${dir}`);
    }
    const data: EnvChangeData = { name, account: account.name, action: 'deleted', dir, unpushed, filesDeleted };
    return { ok: true, data, human: ['', `✅ Environment ${name} removed.${filesDeleted ? '' : ` Files kept in ${dir}.`}`] };
  });
}

export function envServiceCommand(deps: Deps, g: GlobalOptions, name: string, action: 'start' | 'stop' | 'restart'): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const { env } = findEnv(config, name);
    if (env.remoteControl?.enabled === false) throw new UsageError(`environment "${name}" has Remote Control disabled`);
    const exec = newExecutor(deps, g, reporter, false);
    const label = rcLabel(env.account, name);
    const state = await daemonState(exec, label);
    const plist = plistPath(label);

    reporter.step(`env.${name}`, 'start', action);
    if (action === 'stop') {
      if (state.loaded) await stopDaemon(exec, label, `stop ${label}`);
    } else {
      if (!state.loaded) {
        if ((await exec.readText(plist)) === null) throw new DevhostError(`${label} is not installed`, 'service-not-installed', 1, 'Run `devhost apply` to install it.');
        await bootstrapDaemon(exec, label, `load ${label}`);
      } else {
        await exec.exec('launchctl', ['kickstart', ...(action === 'restart' ? ['-k'] : []), `system/${label}`], { sudo: true, reason: `${action} ${label}` });
      }
      const up = await exec.waitFor(async () => (await daemonState(exec, label)).running, 10, 1000);
      if (!up) throw new DevhostError(`${label} did not come up`, 'service-not-running', 1, `Check the log: devhost env logs ${name}`);
    }
    reporter.step(`env.${name}`, 'changed', `${action} done`);
    const data: EnvChangeData = { name, account: env.account, action: action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted' };
    const note = action === 'stop' ? ' It stays stopped until `devhost env start` or the next reboot.' : '';
    return { ok: true, data, human: ['', `✅ ${name}: ${data.action}.${note}`] };
  });
}

/**
 * Put an environment's compose services to sleep, or wake them (A7.9). Sleep notes the services
 * running now and stops them; wake starts exactly those again. The collector does this on its own
 * after docker.idleSleepMinutes without a session, and wakes it with the next one.
 */
export function envSleepCommand(deps: Deps, g: GlobalOptions, name: string, action: 'sleep' | 'wake'): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const { env, account } = findEnv(config, name);
    if (env.compose === 'off') throw new UsageError(`environment "${name}" has compose off: nothing to ${action}`);
    const exec = newExecutor(deps, g, reporter, false);
    const dir = envDir(account, env, deps.home);
    reporter.step(`env.${name}`, 'start', action);
    const state = action === 'sleep' ? await sleepEnv(exec, deps.home, name, dir, deps.now().getTime()) : await wakeEnv(exec, deps.home, name, dir);
    const services = state?.services ?? [];
    reporter.step(`env.${name}`, state ? 'changed' : 'ok', state ? `${action === 'sleep' ? 'stopped' : 'started'} ${services.join(', ')}` : action === 'sleep' ? 'no service runs, or asleep already' : 'awake already');
    const data: EnvChangeData = { name, account: env.account, action: action === 'sleep' ? 'asleep' : 'awake', services };
    const human = !state ? `✅ ${name}: ${action === 'sleep' ? 'nothing runs, or it is asleep already' : 'awake already'}.`
      : action === 'sleep' ? `✅ ${name} is asleep: ${services.join(', ')} stopped. They start again with the next session, or \`devhost env wake ${name}\`.`
      : `✅ ${name} is awake: ${services.join(', ')} started.`;
    return { ok: true, data, human: ['', human] };
  });
}

export interface EnvLogsOptions {
  lines: number;
  follow: boolean;
}

export async function envLogsCommand(deps: Deps, g: GlobalOptions, name: string, opts: EnvLogsOptions): Promise<number> {
  const code = await short<EnvLogsData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const { env } = findEnv(config, name);
    const path = rcLogPath(deps.home, env.account, name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new DevhostError(`no log yet: ${path}`, 'no-log', 1, 'The service has not started. See `devhost env list`.');
    }
    const lines = text.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1).slice(-opts.lines);
    return { data: { name, path, lines }, human: lines.join('\n') };
  });
  if (code !== 0 || !opts.follow || g.json) return code;

  // --follow: poll for appended data until cancelled.
  const path = rcLogPath(deps.home, findEnv((await loadConfig(g.configPath)).config, name).env.account, name);
  let offset = (await stat(path)).size;
  while (!deps.cancel.cancelled) {
    await new Promise((r) => setTimeout(r, 1000));
    const size = (await stat(path)).size;
    if (size > offset) {
      const chunk = (await readFile(path, 'utf8')).slice(offset);
      deps.stdout.write(chunk);
    }
    offset = size;
  }
  return 0;
}

