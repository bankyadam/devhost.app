import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevhostConfig, LoginData } from '@devhost/contract';
import { runSteps } from './apply.js';
import { accountEnv, accountsOf, claudeConfigDir, effectiveClaudeDir, environmentsOf, projectKey, rcLabel, type Account } from './config/accounts.js';
import { editConfigFile } from './config/edit.js';
import { credentialsFile, serviceLogin, syncCredentialsFromKeychain } from './credentials.js';
import type { Deps } from './deps.js';
import { HumanActionRequired } from './errors.js';
import { daemonState } from './launchd.js';
import type { Prompter } from './prompter.js';
import type { Reporter } from './reporter.js';
import type { Executor } from './runner/executor.js';
import type { RunOptions } from './runner/types.js';
import { toolPath } from './state.js';
import { buildSteps, selectSteps } from './steps/index.js';
import { envInfoOf, workspaceTrusted } from './steps/env.js';
import { MIN_REMOTE_CONTROL_VERSION } from './claude-version.js';
import { templatesDir } from './paths.js';
import { recordLogin } from './collector/db.js';
import type { EnvInfo, StepContext } from './steps/types.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

export interface LoginContext {
  deps: Deps;
  /** `--switch-login`: this sign-in may be a different claude.ai login than the account's recorded one. */
  switchLogin?: boolean;
  config: DevhostConfig;
  account: Account;
  exec: Executor;
  reporter: Reporter;
  prompter: Prompter;
  /** Terminal attached and not --json: let the child own the terminal. */
  interactive: boolean;
  /** How long a spawned `claude remote-control` may stay silent before we stop it. */
  idleMs?: number;
  /** Least time between one of its questions and our answer (tests set 0). */
  answerAfterMs?: number;
  /** Builds the step context used to (re)start the account's services. */
  stepContext: () => StepContext;
}

/** Environment for running `claude` as this account (default account: CLAUDE_CONFIG_DIR unset). */
export function claudeRunOptions(a: Account, home: string): Pick<RunOptions, 'env' | 'unsetEnv'> {
  const env = accountEnv(a, home);
  return { env, unsetEnv: Object.keys(env).length === 0 ? ['CLAUDE_CONFIG_DIR'] : [] };
}

export async function claudeBinary(ctx: { exec: Executor; deps: Pick<Deps, 'home' | 'brewPrefix'> }): Promise<string> {
  return toolPath(ctx.exec, ctx.deps.home, 'claudePath', 'claude', `${ctx.deps.brewPrefix}/bin/claude`);
}

/** Who a login is, from `claude auth status`'s JSON (organization id and email); fields missing when it does not say. */
export function loginIdentity(raw: string): { orgId?: string; email?: string } {
  try {
    const data = JSON.parse(raw) as { orgId?: unknown; email?: unknown };
    return {
      ...(typeof data.orgId === 'string' && data.orgId ? { orgId: data.orgId } : {}),
      ...(typeof data.email === 'string' && data.email ? { email: data.email } : {}),
    };
  } catch {
    return {};
  }
}

/** `claude auth status` exits 0 when logged in, 1 when not (verified against the CLI reference). */
export async function authStatus(ctx: { exec: Executor; deps: Pick<Deps, 'home' | 'brewPrefix'> }, a: Account): Promise<{ loggedIn: boolean | null; raw: string }> {
  const r = await ctx.exec.query(await claudeBinary(ctx), ['auth', 'status'], claudeRunOptions(a, ctx.deps.home));
  if (r.code === 127) return { loggedIn: null, raw: r.stderr };
  return { loggedIn: r.code === 0, raw: r.stdout };
}

async function authLogin(ctx: LoginContext): Promise<void> {
  const { deps, account: a } = ctx;
  const claude = await claudeBinary(ctx);
  const opts = claudeRunOptions(a, deps.home);
  if (ctx.interactive) {
    const r = await deps.runner.run(claude, ['auth', 'login'], { ...opts, interactive: true });
    if (r.code !== 0) throw new HumanActionRequired(`claude auth login exited with code ${r.code}`, `Run \`devhost login ${a.name}\` again.`);
    return;
  }

  // No terminal (the desktop app, ssh without -t): relay the URL and the pasted code (spec A7.10).
  const proc = deps.runner.spawn(claude, ['auth', 'login'], opts);
  let buffer = '';
  let asked = false;
  let failure: Error | null = null;
  proc.onData((chunk) => {
    buffer += stripAnsi(chunk);
    const m = asked ? null : /https?:\/\/[^\s]+/.exec(buffer);
    if (!m) return;
    asked = true;
    const url = m[0].replace(/[).,;]+$/, '');
    ctx.prompter
      .openUrl('auth-code', url, `Open this URL on any device, sign in as the "${a.name}" account, and paste the code it shows.`)
      .then((code) => {
        if (code.trim()) proc.write(`${code.trim()}\n`);
      })
      .catch((err: Error) => {
        failure = err;
        proc.kill();
      });
  });
  const code = await proc.wait();
  if (failure) throw failure;
  if (code === 127) throw new HumanActionRequired('Claude Code is not installed', 'Run `devhost apply` first.');
  if (code !== 0) throw new HumanActionRequired(`claude auth login exited with code ${code}`, `Run \`devhost login ${a.name}\` again.`);
}

const TOO_OLD = /too old for Remote Control/i;

export const tooOldForRemoteControl = (dir: string): HumanActionRequired =>
  new HumanActionRequired(
    `Claude Code is too old for Remote Control (${MIN_REMOTE_CONTROL_VERSION} or newer is needed), so ${dir} was not trusted`,
    'Update it with `devhost apply --only claude.binary`, then run this command again.',
  );

const TRUST = /Trust\s+(.+?)\?\s*\[y\/N\]/i;
const ENABLE = /Enable Remote Control\?\s*\(y\/n\)/i;

/** Runs a command on a pseudo-terminal (templates/pty-run.py); the system's own Python, as ssh's PATH has no other. */
export const PTY_PYTHON = '/usr/bin/python3';
export const ptyRunPath = (): string => join(templatesDir, 'pty-run.py');

/**
 * Claude Code ignores an answer to these questions that "arrived too quickly after the question to
 * count" (it asks again), so a person has to have time to read them. The answer waits at least this
 * long after the question, whoever or whatever (`--yes`) gave it.
 */
const ANSWER_AFTER_MS = 1500;

/**
 * Accept the one-time "Trust <dir>?" and "Enable Remote Control?" questions that
 * `claude remote-control` asks (spec A7.10), then stop the server again. Without a
 * terminal the questions are relayed as confirm prompts through a pseudo-terminal
 * (pty-run.py). Returns true only when Claude Code recorded the trust; false when the
 * human declined or Claude Code stopped before it was recorded.
 */
export async function acceptWorkspace(ctx: LoginContext, info: EnvInfo): Promise<boolean> {
  const { deps } = ctx;
  const claude = await claudeBinary(ctx);
  const rcArgs = [claude, 'remote-control', '--name', `${info.account}-${info.name}`, '--spawn', 'same-dir', '--no-create-session-in-dir', '--permission-mode', info.permissionMode];
  const opts: RunOptions = { ...claudeRunOptions(ctx.account, deps.home), cwd: info.dir };

  // Already trusted (an earlier login or create answered both questions): running Claude Code again
  // is pointless, and fails while the environment's own service serves the folder.
  if (await workspaceTrusted(ctx.stepContext(), ctx.account, info.dir)) return true;

  if (ctx.interactive) {
    ctx.reporter.log('info', `Answer the questions below for ${info.dir}, then press Ctrl+C once the server is up.`);
    await deps.runner.run(rcArgs[0]!, rcArgs.slice(1), { ...opts, interactive: true });
    // Its output went to the terminal, so check the outcome: Claude Code may have stopped before asking
    // (too old for Remote Control, not logged in) or the questions were answered "no".
    return workspaceTrusted(ctx.stepContext(), ctx.account, info.dir);
  }

  const proc = deps.runner.spawn(PTY_PYTHON, [ptyRunPath(), ...rcArgs], opts);
  let seen = '';
  let handled = 0;
  let last = Date.now();
  let pending = false;
  let declined = false;
  let failure: Error | null = null;
  let output = '';
  const handle = async (): Promise<void> => {
    if (pending) return;
    const text = seen.slice(handled);
    const trust = TRUST.exec(text);
    const enable = ENABLE.exec(text);
    const hit = [trust, enable].filter((m): m is RegExpExecArray => m !== null).sort((x, y) => x.index - y.index)[0];
    if (!hit) return;
    handled += hit.index + hit[0].length;
    pending = true;
    const asked = Date.now();
    try {
      const message = hit === trust ? `Trust ${hit[1]} and let Claude Code run there?` : 'Enable Remote Control for this account (one-time confirmation)?';
      const yes = await ctx.prompter.confirm(hit === trust ? 'trust-workspace' : 'enable-remote-control', message);
      const wait = (ctx.answerAfterMs ?? ANSWER_AFTER_MS) - (Date.now() - asked);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      proc.write(yes ? 'y\n' : 'n\n');
      if (!yes) {
        declined = true;
        proc.kill();
      }
    } catch (err) {
      failure = err as Error;
      proc.kill();
    } finally {
      pending = false;
      last = Date.now();
    }
    await handle();
  };
  proc.onData((chunk) => {
    const clean = stripAnsi(chunk);
    seen += clean;
    output += clean;
    last = Date.now();
    void handle();
  });

  const done = proc.wait();
  let finished = false;
  void done.then(() => (finished = true));
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  while (!finished) {
    await Promise.race([done, sleep(25)]);
    if (!finished && !pending && Date.now() - last > (ctx.idleMs ?? 8000)) {
      proc.write('\u0003');
      await Promise.race([done, sleep(2000)]);
      if (!finished) proc.kill();
      break;
    }
  }
  const code = await done;
  if (failure) throw failure;
  if (declined) return false;
  if (TOO_OLD.test(output)) throw tooOldForRemoteControl(info.dir);
  if (code === 127 && output.trim() === '') {
    throw new HumanActionRequired(
      `could not start a pseudo-terminal to accept trust for ${info.dir}`,
      `Run this once in a terminal, answer "y" twice, then press Ctrl+C:\n  cd ${info.dir} && ${rcArgs.map((s) => (s.includes(' ') ? `'${s}'` : s)).join(' ')}`,
    );
  }
  // What counts is what Claude Code recorded, not that it ran: it may have stopped before asking.
  return workspaceTrusted(ctx.stepContext(), ctx.account, info.dir);
}

/**
 * The other account already signed in with this login (the same claude.ai email and organization),
 * if any. Two accounts on one login defeat the point: the second's environments register under the
 * first's claude.ai account and do not show up under their own.
 */
export async function sharedLogin(ctx: { exec: Executor; deps: Pick<Deps, 'home' | 'brewPrefix'> }, config: DevhostConfig, a: Account, raw: string): Promise<{ account: string; email: string } | null> {
  const me = loginIdentity(raw);
  if (!me.email) return null;
  for (const other of accountsOf(config)) {
    if (other.name === a.name) continue;
    const st = await authStatus(ctx, other);
    if (st.loggedIn !== true) continue;
    const them = loginIdentity(st.raw);
    if (them.email === me.email && (them.orgId ?? '') === (me.orgId ?? '')) return { account: other.name, email: me.email };
  }
  return null;
}

async function authLogout(ctx: LoginContext): Promise<void> {
  await ctx.exec.query(await claudeBinary(ctx), ['auth', 'logout'], claudeRunOptions(ctx.account, ctx.deps.home));
}

/** `accounts[].claudeLogin` in config.yaml. */
async function pinLogin(ctx: LoginContext, email: string): Promise<void> {
  const i = (ctx.config.accounts ?? []).findIndex((x) => x.name === ctx.account.name);
  if (i < 0) return;
  await editConfigFile(ctx.stepContext().configPath, ctx.deps.now(), (doc) => doc.setIn(['accounts', i, 'claudeLogin'], email));
}

/**
 * Forget the account's Remote Control registrations: the bridge pointers of its environments (and
 * their worktrees), which make a restarted service reattach to the same environment, and the device
 * id (`remoteControlMachineId`), under which the server refuses a second environment for a folder.
 */
export async function resetRemoteControlState(ctx: LoginContext): Promise<void> {
  const { account: a, deps, exec } = ctx;
  const projects = join(effectiveClaudeDir(a, deps.home), 'projects');
  const keys = environmentsOf(ctx.config).filter((e) => e.account === a.name).map((e) => projectKey(envInfoOf(a, e, deps.home).dir));
  let names: string[] = [];
  try {
    names = await readdir(projects);
  } catch {
    /* no projects yet */
  }
  for (const n of names) {
    if (keys.some((k) => n === k || n.startsWith(`${k}-`)) && existsSync(join(projects, n, 'bridge-pointer.json'))) await exec.remove(join(projects, n, 'bridge-pointer.json'));
  }
  const dir = claudeConfigDir(a, deps.home);
  const stateFile = dir ? join(dir, '.claude.json') : join(deps.home, '.claude.json');
  const text = await exec.readText(stateFile);
  if (text === null) return;
  try {
    const state = JSON.parse(text) as Record<string, unknown>;
    if (!('remoteControlMachineId' in state)) return;
    delete state['remoteControlMachineId'];
    await exec.writeText(stateFile, `${JSON.stringify(state, null, 2)}\n`, { description: `forget the Remote Control device id in ${stateFile}` });
  } catch {
    /* not JSON: leave it */
  }
}

/** What `devhost login <account>` does (spec A7.10). */
export async function loginAccount(ctx: LoginContext): Promise<LoginData> {
  const { account: a, config, deps, reporter } = ctx;

  reporter.step('login.auth', 'start', `sign in ${a.name}`);
  const before = loginIdentity((await authStatus(ctx, a)).raw).email;
  await authLogin(ctx);
  const status = await authStatus(ctx, a);
  if (status.loggedIn !== true) {
    reporter.step('login.auth', 'failed', 'claude auth status still reports a logged-out account');
    throw new HumanActionRequired(`${a.name} is still not logged in`, `Run \`devhost login ${a.name}\` again and paste the code the browser shows.`);
  }
  // A wrong login is signed out again: running on it, the account's services would register its
  // environments under someone else's claude.ai account (and keep them there).
  const who = loginIdentity(status.raw);
  const clash = await sharedLogin(ctx, config, a, status.raw);
  if (clash) {
    reporter.step('login.auth', 'failed', `signed in as ${clash.email}, the login of ${clash.account}`);
    await authLogout(ctx);
    throw new HumanActionRequired(
      `${a.name} signed in as ${clash.email}, which is ${clash.account}'s login (its environments would show up under ${clash.account}); signed out again`,
      `Sign out of claude.ai in the browser (or open the link in a private window), then run \`devhost login ${a.name}\` again and sign in with ${a.claudeLogin ?? `${a.name}'s login`}.`,
    );
  }
  const pinned = a.claudeLogin ?? null;
  if (pinned && who.email && who.email !== pinned && !ctx.switchLogin) {
    reporter.step('login.auth', 'failed', `signed in as ${who.email}, not ${pinned}`);
    await authLogout(ctx);
    throw new HumanActionRequired(
      `${a.name} signs in as ${pinned}, this was ${who.email}; signed out again`,
      `Run \`devhost login ${a.name}\` again and sign in with ${pinned} (a private window avoids the browser's current login). To make ${who.email} its login: devhost login ${a.name} --switch-login`,
    );
  }
  // The services read .credentials.json, which a sign-in with an unlocked Keychain leaves alone.
  const svc = await serviceLogin(ctx.exec, a, deps.home);
  if (svc?.email && who.email && svc.email !== who.email) {
    const synced = await syncCredentialsFromKeychain(ctx.exec, a, deps.home);
    const again = synced ? await serviceLogin(ctx.exec, a, deps.home) : svc;
    if (again?.email && again.email !== who.email) {
      reporter.step('login.auth', 'failed', `the services' login is still ${again.email}`);
      throw new HumanActionRequired(
        `${a.name} is signed in as ${who.email} in the Keychain, but its services read ${credentialsFile(a, deps.home)}, which is still signed in as ${again.email}`,
        `Run \`devhost login ${a.name}\` from the devhost app or over ssh (there the login is written to that file), or remove the file and sign in again.`,
      );
    }
    reporter.step('login.auth', 'changed', `copied the new login to ${credentialsFile(a, deps.home)} for the services`);
  }
  // The services ran as someone else: what they registered belongs to that login.
  const previous = svc?.email && svc.email !== who.email ? svc.email : (pinned ?? before ?? null);
  if (who.email && previous && previous !== who.email) {
    // Another login: what Remote Control remembers (environment and session pointers, the device
    // id it registered under) belongs to the old one, and reusing it keeps the environments there.
    await resetRemoteControlState(ctx);
    reporter.step('login.auth', 'changed', `switched from ${previous} to ${who.email}; Remote Control registers its environments afresh`);
  }
  if (who.email && pinned !== who.email) await pinLogin(ctx, who.email);
  reporter.step('login.auth', 'changed', 'logged in');
  recordLogin(deps.home, a.name, deps.now().getTime(), loginIdentity(status.raw).orgId);

  const trusted: string[] = [];
  const envs = environmentsOf(config).filter((e) => e.account === a.name);
  for (const e of envs) {
    if (e.remoteControl?.enabled === false) continue;
    const info = envInfoOf(a, e, deps.home);
    if ((await ctx.exec.query('test', ['-d', info.dir])).code !== 0) {
      reporter.step(`login.trust.${e.name}`, 'skipped', `${info.dir} does not exist yet`);
      continue;
    }
    reporter.step(`login.trust.${e.name}`, 'start', info.dir);
    if (await acceptWorkspace(ctx, info)) {
      trusted.push(info.dir);
      reporter.step(`login.trust.${e.name}`, 'ok');
    } else {
      reporter.step(`login.trust.${e.name}`, 'skipped', 'not trusted: declined, or Claude Code stopped before asking (see above)');
    }
  }

  const restarted: string[] = [];
  if (envs.length > 0) {
    const steps = selectSteps(buildSteps(config), envs.map((e) => `env.${e.name}`));
    const outcome = await runSteps(steps, ctx.stepContext(), reporter, deps.cancel);
    if (outcome.error) throw outcome.error;
    // A service whose plist did not change is left running by its step, still on the old login
    // (its sessions are gone from claude.ai), so restart it here.
    for (const e of envs) {
      if (e.remoteControl?.enabled === false) continue;
      const status = outcome.data.steps.find((s) => s.id === `env.${e.name}`)?.status;
      const label = rcLabel(a.name, e.name);
      if (status === 'ok' && (await daemonState(ctx.exec, label)).running) {
        await ctx.exec.exec('launchctl', ['kickstart', '-k', `system/${label}`], { sudo: true, reason: `restart ${label} so it uses the new login` });
      } else if (status !== 'changed') {
        continue;
      }
      restarted.push(e.name);
    }
  }
  return { account: a.name, loggedIn: true, trusted, restarted, remaining: [] };
}
