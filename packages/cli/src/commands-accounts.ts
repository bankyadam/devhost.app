import type { AccountChangeData, AccountListData, DevhostConfig, LoginData } from '@devhost/contract';
import { runSteps } from './apply.js';
import { long, newExecutor, newStepContext, short, type GlobalOptions } from './command-support.js';
import { accountsOf, environmentsOf, findAccount, type Account } from './config/accounts.js';
import { appendTo, editConfigFile, removeFrom } from './config/edit.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { UsageError } from './errors.js';
import { authStatus, claudeBinary, claudeRunOptions, loginAccount, type LoginContext } from './login.js';
import { allocateAccountRange } from './ports.js';
import { makePrompter } from './prompter.js';
import { newReporter } from './command-support.js';
import { buildSteps, selectSteps } from './steps/index.js';
import { removeAccountArtifacts } from './steps/accounts-remove.js';
import type { Reporter } from './reporter.js';

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;

export function accountListCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<AccountListData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const accounts: AccountListData['accounts'] = [];
    for (const a of accountsOf(config)) {
      const st = await authStatus({ exec, deps }, a);
      accounts.push({
        name: a.name,
        default: a.default === true,
        configDir: a.configDir ?? null,
        root: a.root,
        portRange: [a.portRange[0], a.portRange[1]],
        loggedIn: st.loggedIn,
        environments: environmentsOf(config).filter((e) => e.account === a.name).length,
      });
    }
    const human =
      accounts.length === 0
        ? 'No accounts yet. Add one with `devhost account add --name <name> --git-email <email>`.'
        : [
            'NAME\tDEFAULT\tCONFIG DIR\tROOT\tPORTS\tLOGGED IN\tENVS',
            ...accounts.map((a) => [a.name, a.default ? 'yes' : 'no', a.configDir ?? '(default)', a.root, a.portRange.join('-'), a.loggedIn === null ? '?' : a.loggedIn ? 'yes' : 'no', a.environments].join('\t')),
          ].join('\n');
    return { data: { accounts }, human };
  });
}

export interface AccountAddOptions {
  name: string;
  gitEmail: string;
  gitName?: string;
  default: boolean;
  dailyCostAlert?: number;
  noLogin: boolean;
  forceDefaultSwitch: boolean;
}

export function accountAddCommand(deps: Deps, g: GlobalOptions, opts: AccountAddOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    if (!SLUG.test(opts.name)) throw new UsageError(`"${opts.name}" is not a valid account name`, 'Use lowercase letters, digits and dashes, starting with a letter (max 32).');
    const loaded = await loadConfig(g.configPath);
    // Re-running add for an account that is already in the config continues its setup (e.g. after a
    // step stopped it), as long as the git email and the default flag match; the config's settings win.
    const existing = findAccount(loaded.config, opts.name);
    if (existing) {
      const differs = [
        ...(existing.git.email !== opts.gitEmail ? [`with git email ${existing.git.email}`] : []),
        ...((existing.default === true) !== opts.default ? [existing.default ? 'as the default account' : 'as a non-default account'] : []),
      ];
      if (differs.length > 0) {
        throw new UsageError(`account "${opts.name}" already exists ${differs.join(' and ')}`, `Use another name, or remove it first: devhost account remove ${opts.name}`);
      }
    }
    const existingDefault = accountsOf(loaded.config).find((a) => a.default === true);
    if (opts.forceDefaultSwitch) {
      throw new UsageError('--force-default-switch is not supported in v1', 'Moving the default would re-point CLAUDE_CONFIG_DIR for existing environments. Remove the old default account first, or add this one as non-default.');
    }
    if (!existing && opts.default && existingDefault) {
      throw new UsageError(`"${existingDefault.name}" is already the default account`, 'Only one account can use Claude Code\'s default config dir. Add this account without --default.');
    }
    let config = loaded.config;
    if (existing) {
      reporter.step('config', 'ok', `already in ${g.configPath}; continuing its setup with the settings there`);
    } else {
      const gitName = opts.gitName ?? process.env['GIT_AUTHOR_NAME'] ?? deps.env['GIT_AUTHOR_NAME'] ?? opts.name;
      const portRange = allocateAccountRange(loaded.config);
      const entry = {
        name: opts.name,
        default: opts.default,
        configDir: opts.default ? null : `~/.claude-${opts.name}`,
        root: `~/work/${opts.name}`,
        portRange,
        git: { name: gitName, email: opts.gitEmail },
        alerts: { dailyCostUsd: opts.dailyCostAlert ?? null },
      };
      reporter.step('config', 'start', `add account ${opts.name} to ${g.configPath}`);
      ({ config } = await editConfigFile(g.configPath, deps.now(), (doc) => appendTo(doc, 'accounts', entry)));
      reporter.step('config', 'changed', `port range ${portRange.join('-')}`);
    }

    const exec = newExecutor(deps, g, reporter, false);
    const account = findAccount(config, opts.name)!;
    const ctx = newStepContext(deps, g, config, exec, { onlyAccount: opts.name });
    const steps = selectSteps(buildSteps(config), ['accounts', 'shell']);
    const outcome = await runSteps(steps, ctx, reporter, deps.cancel);
    const data: AccountChangeData = {
      name: opts.name,
      action: 'added',
      portRange: account.portRange,
      configDir: account.configDir ?? null,
      root: account.root,
      loggedIn: null,
      steps: outcome.data.steps.map(({ id, status, message }) => ({ id, status, ...(message ? { message } : {}) })),
    };
    if (outcome.error || outcome.cancelled) return { ok: false, data, error: outcome.error, cancelled: outcome.cancelled };

    let login: LoginData | null = null;
    if (!opts.noLogin) {
      login = await runLogin(deps, g, config, account, reporter);
      data.loggedIn = login.loggedIn;
    }
    return {
      ok: true,
      data,
      human: [
        '',
        `✅ Account "${opts.name}" ${existing ? 'set up' : 'added'} (port range ${account.portRange.join('-')}, config dir ${account.configDir ?? '~/.claude (default)'}).`,
        login ? '' : `Not logged in yet: run \`devhost login ${opts.name}\`.`,
      ].filter((l, i, all) => l !== '' || i < all.length - 1),
    };
  });
}

export function accountRemoveCommand(deps: Deps, g: GlobalOptions, name: string, opts: { logout: boolean }): Promise<number> {
  return long(deps, g, async (reporter) => {
    const loaded = await loadConfig(g.configPath);
    const account = findAccount(loaded.config, name);
    if (!account) throw new UsageError(`no account named "${name}"`);
    const envs = environmentsOf(loaded.config).filter((e) => e.account === name);
    if (envs.length > 0) {
      throw new UsageError(`account "${name}" still has environments: ${envs.map((e) => e.name).join(', ')}`, `Remove them first: ${envs.map((e) => `devhost env delete ${e.name}`).join(' && ')}`);
    }

    const exec = newExecutor(deps, g, reporter, false);
    if (opts.logout) {
      reporter.step('logout', 'start', name);
      const r = await exec.query(await claudeBinary({ exec, deps }), ['auth', 'logout'], claudeRunOptions(account, deps.home));
      reporter.step('logout', r.code === 0 ? 'changed' : 'skipped', r.code === 0 ? 'logged out' : `claude auth logout exited ${r.code}`);
    }

    // Remove artifacts with the OLD config (it knows the account), then drop the entry
    // and regenerate the shared blocks (zshrc aliases, gitconfig includeIf) without it.
    reporter.step('artifacts', 'start', `remove devhost-managed files for ${name}`);
    const kept = await removeAccountArtifacts(newStepContext(deps, g, loaded.config, exec), account, loaded.config);
    reporter.step('artifacts', 'changed');

    reporter.step('config', 'start', `remove account ${name} from ${g.configPath}`);
    const { config } = await editConfigFile(g.configPath, deps.now(), (doc) => removeFrom(doc, 'accounts', (a) => a['name'] === name));
    reporter.step('config', 'changed');

    const outcome = await runSteps(selectSteps(buildSteps(config), ['shell', 'accounts.git']), newStepContext(deps, g, config, exec), reporter, deps.cancel);
    const data: AccountChangeData = {
      name,
      action: 'removed',
      steps: outcome.data.steps.map(({ id, status, message }) => ({ id, status, ...(message ? { message } : {}) })),
      kept,
    };
    return {
      ok: outcome.error === null,
      data,
      error: outcome.error,
      cancelled: outcome.cancelled,
      human: ['', `✅ Account "${name}" removed. Kept on disk: ${kept.join(', ')}.`],
    };
  });
}

export async function runLogin(deps: Deps, g: GlobalOptions, config: DevhostConfig, account: Account, reporter: Reporter, switchLogin = false): Promise<LoginData> {
  const exec = newExecutor(deps, g, reporter, false);
  const ctx: LoginContext = {
    deps,
    config,
    account,
    exec,
    reporter,
    prompter: makePrompter(deps, g.json, g.yes),
    interactive: deps.stdinIsTTY && !g.json,
    idleMs: Number(deps.env['DEVHOST_TRUST_IDLE_MS']) || undefined,
      answerAfterMs: deps.env['DEVHOST_TRUST_ANSWER_MS'] === undefined ? undefined : Number(deps.env['DEVHOST_TRUST_ANSWER_MS']),
    stepContext: () => newStepContext(deps, g, config, exec),
    switchLogin,
  };
  return loginAccount(ctx);
}

export function loginCommand(deps: Deps, g: GlobalOptions, name: string, switchLogin = false): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const account = findAccount(config, name);
    if (!account) throw new UsageError(`no account named "${name}"`, 'See `devhost account list`.');
    const data = await runLogin(deps, g, config, account, reporter, switchLogin);
    return { ok: true, data, human: ['', `✅ ${name} is logged in${(data.restarted?.length ?? 0) > 0 ? `; restarted: ${(data.restarted ?? []).join(', ')}` : ''}.`] };
  });
}

