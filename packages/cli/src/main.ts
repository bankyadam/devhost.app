import { Command, CommanderError } from 'commander';
import { ExitCode } from '@devhost/contract';
import {
  applyCommand,
  cliVersion,
  configEditCommand,
  configGetCommand,
  configPutCommand,
  configRawCommand,
  configSetCommand,
  configValidateCommand,
  initCommand,
  versionCommand,
} from './commands.js';
import type { GlobalOptions } from './command-support.js';
import { accountAddCommand, accountListCommand, accountRemoveCommand, loginCommand } from './commands-accounts.js';
import { envCreateCommand, envDeleteCommand, envListCommand, envLogsCommand, envServiceCommand } from './commands-env.js';
import { collectorLogsCommand, collectorRunCommand, dashCommand, notifyCommand, topCommand } from './commands-collector.js';
import { doctorCommand, statusCommand, uninstallCommand } from './commands-doctor.js';
import { sessionReattachCommand } from './reattach.js';
import { pluginInstallCommand, pluginListCommand, pluginRunCommand, pluginToggleCommand, pluginUninstallCommand, pluginWidgetsCommand } from './commands-plugins.js';
import { closeInput } from './prompter.js';
import { resolveConfigPath } from './config/paths.js';
import type { Deps } from './deps.js';
import { errorEntries, exitCodeFor, writeEnvelope, writeHumanError } from './output.js';
import { UsageError } from './errors.js';

interface RootOpts {
  json?: boolean;
  verbose?: boolean;
  yes?: boolean;
  config?: string;
}

/** Entry point shared by bin and tests: parse argv, run the command, return the exit code. */
export async function main(argv: string[], deps: Deps): Promise<number> {
  try {
    return await mainInner(argv, deps);
  } finally {
    closeInput(deps);
  }
}

async function mainInner(argv: string[], deps: Deps): Promise<number> {
  let exit: number | undefined;
  const run = (fn: () => Promise<number>): (() => Promise<void>) => async () => {
    exit = await fn();
  };

  const program = new Command();
  const globals = (): GlobalOptions => {
    const o = program.opts<RootOpts>();
    return {
      json: o.json === true,
      verbose: o.verbose === true,
      yes: o.yes === true,
      configPath: resolveConfigPath(o.config, deps.home, process.cwd()),
    };
  };

  program
    .name('devhost')
    .description('Turn a Mac mini (Apple Silicon or Intel) into a headless Claude Code dev server')
    .version(cliVersion(), '-V, --cli-version', 'print the CLI version')
    .option('--json', 'machine-readable output (see the contract package)')
    .option('--verbose', 'show every command that is run')
    .option('-y, --yes', 'never ask questions; use defaults')
    .option('--config <path>', 'config file (default: ~/.config/devhost/config.yaml)')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
    });

  program
    .command('init')
    .description('Create ~/.config/devhost/config.yaml (asks a few questions)')
    .option('--force', 'overwrite an existing config (a backup is kept)')
    .option('--hostname <name>', 'hostname of the Mac mini')
    .option('--docker <runtime>', 'colima | orbstack | none')
    .option('--no-tailscale', 'do not set up Tailscale')
    .action(
      run(() => {
        const o = program.commands.find((c) => c.name() === 'init')!.opts<{ force?: boolean; hostname?: string; docker?: string; tailscale: boolean }>();
        return initCommand(deps, globals(), {
          force: o.force === true,
          nonInteractive: !deps.stdinIsTTY,
          hostname: o.hostname,
          docker: o.docker,
          tailscale: o.tailscale,
        });
      }),
    );

  program
    .command('apply')
    .description('Make this Mac match the config (idempotent)')
    .option('--dry-run', 'print the plan, including every sudo command, and change nothing')
    .option('--only <step...>', 'run only these steps, e.g. system or system.power')
    .action(
      run(() => {
        const o = program.commands.find((c) => c.name() === 'apply')!.opts<{ dryRun?: boolean; only?: string[] }>();
        const only = (o.only ?? []).flatMap((s) => s.split(',')).filter(Boolean);
        return applyCommand(deps, globals(), { dryRun: o.dryRun === true, only });
      }),
    );

  const config = program.command('config').description('Read and change the config file');
  config
    .command('get [pointer]')
    .description('Print the effective config, or the value at a JSON pointer such as /machine/hostname')
    .action((pointer: string | undefined) => run(() => configGetCommand(deps, globals(), pointer ?? ''))());
  config
    .command('set <pointer> <value>')
    .description('Set a value (JSON/YAML syntax) and validate the result; does not apply it')
    .action((pointer: string, value: string) => run(() => configSetCommand(deps, globals(), pointer, value))());
  config
    .command('validate')
    .description('Validate the config file, or with --stdin a candidate document')
    .option('--stdin', 'read the YAML to validate from stdin')
    .action(run(() => configValidateCommand(deps, globals(), { stdin: config.commands.find((c) => c.name() === 'validate')!.opts<{ stdin?: boolean }>().stdin === true })));
  config.command('raw').description('Print the config file as it is on disk (comments included)').action(run(() => configRawCommand(deps, globals())));
  config.command('put').description('Replace the config with the YAML on stdin, if it validates (a backup is kept)').action(run(() => configPutCommand(deps, globals())));
  config
    .command('edit')
    .description('Open the config in $EDITOR and validate it afterwards')
    .action(run(() => configEditCommand(deps, globals())));

  const account = program.command('account').description('Manage Claude accounts');
  account
    .command('list')
    .description('List accounts with login state and environment count')
    .action(run(() => accountListCommand(deps, globals())));
  account
    .command('add')
    .description('Add an account: config, settings, routing, git identity, then login')
    .requiredOption('--name <name>', 'account name (slug)')
    .requiredOption('--git-email <email>', 'git email for repositories under the account root')
    .option('--git-name <name>', 'git author name')
    .option('--default', 'use Claude Code\'s default config dir (only one account may)')
    .option('--daily-cost-alert <usd>', 'alert when the estimated daily cost passes this', (v) => Number(v))
    .option('--no-login', 'skip the login flow; doctor will report the account as not logged in')
    .option('--force-default-switch', 'not supported in v1')
    .action(
      run(() => {
        const o = account.commands.find((c) => c.name() === 'add')!.opts<{ name: string; gitEmail: string; gitName?: string; default?: boolean; dailyCostAlert?: number; login: boolean; forceDefaultSwitch?: boolean }>();
        return accountAddCommand(deps, globals(), {
          name: o.name,
          gitEmail: o.gitEmail,
          gitName: o.gitName,
          default: o.default === true,
          dailyCostAlert: o.dailyCostAlert,
          noLogin: !o.login,
          forceDefaultSwitch: o.forceDefaultSwitch === true,
        });
      }),
    );
  account
    .command('remove <name>')
    .description('Remove an account (refused while it has environments); never deletes files or credentials')
    .option('--logout', 'also run `claude auth logout` for the account')
    .action((name: string, o: { logout?: boolean }) => run(() => accountRemoveCommand(deps, globals(), name, { logout: o.logout === true }))());

  program
    .command('login <account>')
    .description('Sign in an account, accept workspace trust for its environments, restart their services')
    .option('--switch-login', "accept a claude.ai login other than the account's recorded one (its environments register afresh)")
    .action((name: string, o: { switchLogin?: boolean }) => run(() => loginCommand(deps, globals(), name, o.switchLogin === true))());

  const env = program.command('env').description('Manage environments (one project each)');
  env.command('list').description('List environments and their Remote Control service state').action(run(() => envListCommand(deps, globals())));
  env
    .command('create')
    .description('Create an environment: repo, ports, .envrc, compose, Remote Control service')
    .requiredOption('--account <account>', 'owning account')
    .requiredOption('--name <name>', 'environment name (slug)')
    .option('--repo <url>', 'git repository to clone (omit for git init)')
    .option('--no-rc', 'do not install a Remote Control service')
    .option('--compose <mode>', 'auto | off', 'auto')
    .option('--spawn <mode>', 'worktree | same-dir')
    .option('--permission-mode <mode>', 'permission mode for Remote Control sessions')
    .action(
      run(() => {
        const o = env.commands.find((c) => c.name() === 'create')!.opts<{ account: string; name: string; repo?: string; rc: boolean; compose: string; spawn?: string; permissionMode?: string }>();
        if (o.compose !== 'auto' && o.compose !== 'off') throw new UsageError('--compose must be auto or off');
        return envCreateCommand(deps, globals(), { account: o.account, name: o.name, repo: o.repo, noRc: !o.rc, compose: o.compose, spawn: o.spawn, permissionMode: o.permissionMode });
      }),
    );
  env
    .command('delete <name>')
    .description('Stop and remove an environment; files stay unless --delete-files')
    .option('--delete-files', 'also delete the project directory (typed confirmation required)')
    .option('--confirm-name <name>', 'the typed confirmation, for scripts')
    .action((name: string, o: { deleteFiles?: boolean; confirmName?: string }) => run(() => envDeleteCommand(deps, globals(), name, { deleteFiles: o.deleteFiles === true, confirmName: o.confirmName }))());
  for (const action of ['start', 'stop', 'restart'] as const) {
    env.command(`${action} <name>`).description(`${action[0]!.toUpperCase()}${action.slice(1)} an environment's Remote Control service`).action((name: string) => run(() => envServiceCommand(deps, globals(), name, action))());
  }
  env
    .command('logs <name>')
    .description('Show the Remote Control service log')
    .option('-n, --lines <n>', 'number of lines', (v) => Number(v), 50)
    .option('-f, --follow', 'keep printing new lines (not with --json)')
    .action((name: string, o: { lines: number; follow?: boolean }) => run(() => envLogsCommand(deps, globals(), name, { lines: o.lines, follow: o.follow === true }))());

  const collector = program.command('collector').description('The collector service (telemetry, samplers, alerts)');
  collector
    .command('run')
    .description('Run the collector in the foreground (used by launchd and for debugging)')
    .action(run(() => collectorRunCommand(deps, globals())));
  collector
    .command('logs')
    .description('Show the collector log')
    .option('-n, --lines <n>', 'number of lines', (v) => Number(v), 50)
    .action(run(() => collectorLogsCommand(deps, globals(), { lines: collector.commands.find((c) => c.name() === 'logs')!.opts<{ lines: number }>().lines })));

  program
    .command('dash')
    .description('Dashboard snapshot (sessions, tokens, cost, CPU/RAM); --follow streams updates')
    .option('--range <range>', '1h | 24h | 7d | 30d', '24h')
    .option('--account <name>', 'only this account')
    .option('--env <name>', 'only this environment')
    .option('--model <name>', 'only this model')
    .option('--follow', 'stream a snapshot every sampleIntervalSeconds (NDJSON with --json)')
    .action(
      run(() => {
        const o = program.commands.find((c) => c.name() === 'dash')!.opts<{ range: string; account?: string; env?: string; model?: string; follow?: boolean }>();
        return dashCommand(deps, globals(), { range: o.range, account: o.account, env: o.env, model: o.model, follow: o.follow === true });
      }),
    );
  program
    .command('top')
    .description('The dashboard as a refreshing terminal table (works over SSH)')
    .option('--once', 'print once and exit')
    .action(run(() => topCommand(deps, globals(), { once: program.commands.find((c) => c.name() === 'top')!.opts<{ once?: boolean }>().once === true })));
  program
    .command('notify')
    .description('Notifications')
    .option('--test', 'send a test notification')
    .action(run(() => notifyCommand(deps, globals(), { test: program.commands.find((c) => c.name() === 'notify')!.opts<{ test?: boolean }>().test === true })));

  const session = program.command('session').description('Claude Code sessions on this host');
  session
    .command('reattach <id>')
    .description('Bring an ended Remote Control session back (e.g. after a reboot): runs it again in its worktree, once')
    .option('--dry-run', 'only print the plan')
    .action((id: string, o: { dryRun?: boolean }) => run(() => sessionReattachCommand(deps, globals(), id, o.dryRun === true))());

  const plugin = program.command('plugin').description('devhost plugins: built-in ones and ~/.config/devhost/plugins');
  plugin.command('list').description('Plugins, their actions and checks').action(run(() => pluginListCommand(deps, globals())));
  plugin
    .command('widgets')
    .description("Enabled plugins' dashboard controls and cards (the desktop app shows them)")
    .option('--param <plugin.filter=value>', 'a filter value (repeatable)', (v: string, all: string[]) => [...all, v], [] as string[])
    .action((o: { param: string[] }) => run(() => pluginWidgetsCommand(deps, globals(), o.param))());
  plugin
    .command('run <plugin> <action>')
    .description("Run a plugin's action (one that removes or stops something asks first; --yes answers)")
    .option('--env <name>', 'the environment, for an environment action')
    .option('--session <id>', 'the session (id or its first 8 characters), for a session action')
    .option('--dry-run', 'show what would change, change nothing')
    .action((name: string, action: string, o: { env?: string; session?: string; dryRun?: boolean }) => run(() => pluginRunCommand(deps, globals(), { plugin: name, action, env: o.env, session: o.session, dryRun: o.dryRun === true }))());

  plugin
    .command('install <source>')
    .description('Install a plugin from GitHub (URL or owner/repo, #branch or #tag); it stays off until enabled')
    .option('--name <name>', 'install under this name (default: the repository name without devhost-plugin-)')
    .option('--enable', 'enable it right away (it runs code from the repository on this Mac as you)')
    .option('--dry-run', 'show what would happen')
    .action((source: string, o: { name?: string; enable?: boolean; dryRun?: boolean }) => run(() => pluginInstallCommand(deps, globals(), { source, name: o.name, enable: o.enable === true, dryRun: o.dryRun === true }))());
  plugin.command('uninstall <name>').description('Remove an installed plugin and its config entry (built-in ones: disable)').action((name: string) => run(() => pluginUninstallCommand(deps, globals(), name))());
  plugin.command('enable <name>').description('Turn a plugin on').action((name: string) => run(() => pluginToggleCommand(deps, globals(), name, true))());
  plugin.command('disable <name>').description('Turn a plugin off').action((name: string) => run(() => pluginToggleCommand(deps, globals(), name, false))());

  program.command('doctor').description('Read-only health checks with one-line fixes; exit 1 on any failure').action(run(() => doctorCommand(deps, globals())));
  program.command('status').description('One-screen summary').action(run(() => statusCommand(deps, globals())));
  program
    .command('uninstall')
    .description('Remove services, shell/git blocks and generated files; never projects, Claude config dirs or credentials')
    .option('--keep-packages', 'do not uninstall Homebrew packages')
    .option('--purge-data', 'also delete the collector database')
    .option('--dry-run', 'print what would be removed, including every sudo command')
    .action(
      run(() => {
        const o = program.commands.find((c) => c.name() === 'uninstall')!.opts<{ keepPackages?: boolean; purgeData?: boolean; dryRun?: boolean }>();
        return uninstallCommand(deps, globals(), { keepPackages: o.keepPackages === true, purgeData: o.purgeData === true, dryRun: o.dryRun === true });
      }),
    );

  program
    .command('version')
    .description('Print CLI and contract versions')
    .action(run(() => versionCommand(deps, globals())));

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return ExitCode.Ok;
      const usage = new UsageError(err.message.replace(/^error: /, ''));
      if (argv.includes('--json')) writeEnvelope(deps, false, null, [{ code: usage.code, message: usage.message }]);
      return ExitCode.Usage;
    }
    const g = globals();
    if (g.json) writeEnvelope(deps, false, null, errorEntries(err));
    else writeHumanError(deps, err);
    return exitCodeFor(err);
  }
  return exit ?? ExitCode.Ok;
}
