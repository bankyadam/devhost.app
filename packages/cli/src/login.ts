import type { DevhostConfig, LoginData } from '@devhost/contract';
import { runSteps } from './apply.js';
import { accountEnv, environmentsOf, type Account } from './config/accounts.js';
import type { Deps } from './deps.js';
import { HumanActionRequired } from './errors.js';
import type { Prompter } from './prompter.js';
import type { Reporter } from './reporter.js';
import type { Executor } from './runner/executor.js';
import type { RunOptions } from './runner/types.js';
import { toolPath } from './state.js';
import { buildSteps, selectSteps } from './steps/index.js';
import { envInfoOf, workspaceTrusted } from './steps/env.js';
import { MIN_REMOTE_CONTROL_VERSION } from './claude-version.js';
import type { EnvInfo, StepContext } from './steps/types.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

export interface LoginContext {
  deps: Deps;
  config: DevhostConfig;
  account: Account;
  exec: Executor;
  reporter: Reporter;
  prompter: Prompter;
  /** Terminal attached and not --json: let the child own the terminal. */
  interactive: boolean;
  /** How long a spawned `claude remote-control` may stay silent before we stop it. */
  idleMs?: number;
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

/**
 * Accept the one-time "Trust <dir>?" and "Enable Remote Control?" questions that
 * `claude remote-control` asks (spec A7.10), then stop the server again. Without a
 * terminal the questions are relayed as confirm prompts through a pseudo-terminal
 * made with `script`. Returns false when the human declined.
 */
export async function acceptWorkspace(ctx: LoginContext, info: EnvInfo): Promise<boolean> {
  const { deps } = ctx;
  const claude = await claudeBinary(ctx);
  const rcArgs = [claude, 'remote-control', '--name', `${info.account}-${info.name}`, '--spawn', 'same-dir', '--no-create-session-in-dir', '--permission-mode', info.permissionMode];
  const opts: RunOptions = { ...claudeRunOptions(ctx.account, deps.home), cwd: info.dir };

  if (ctx.interactive) {
    ctx.reporter.log('info', `Answer the questions below for ${info.dir}, then press Ctrl+C once the server is up.`);
    await deps.runner.run(rcArgs[0]!, rcArgs.slice(1), { ...opts, interactive: true });
    // Its output went to the terminal, so check the outcome: Claude Code may have stopped before asking
    // (too old for Remote Control, not logged in) or the questions were answered "no".
    return workspaceTrusted(ctx.stepContext(), ctx.account, info.dir);
  }

  const proc = deps.runner.spawn('script', ['-q', '/dev/null', ...rcArgs], opts);
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
    try {
      const message = hit === trust ? `Trust ${hit[1]} and let Claude Code run there?` : 'Enable Remote Control for this account (one-time confirmation)?';
      const yes = await ctx.prompter.confirm(hit === trust ? 'trust-workspace' : 'enable-remote-control', message);
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
  return true;
}

/** What `devhost login <account>` does (spec A7.10). */
export async function loginAccount(ctx: LoginContext): Promise<LoginData> {
  const { account: a, config, deps, reporter } = ctx;

  reporter.step('login.auth', 'start', `sign in ${a.name}`);
  await authLogin(ctx);
  const status = await authStatus(ctx, a);
  if (status.loggedIn !== true) {
    reporter.step('login.auth', 'failed', 'claude auth status still reports a logged-out account');
    throw new HumanActionRequired(`${a.name} is still not logged in`, `Run \`devhost login ${a.name}\` again and paste the code the browser shows.`);
  }
  reporter.step('login.auth', 'changed', 'logged in');

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
    restarted.push(...envs.map((e) => e.name));
  }
  return { account: a.name, loggedIn: true, trusted, restarted, remaining: [] };
}
