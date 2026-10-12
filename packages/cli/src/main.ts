import { Command, CommanderError } from 'commander';
import { ExitCode } from '@devhost/contract';
import {
  applyCommand,
  cliVersion,
  configEditCommand,
  configGetCommand,
  configSetCommand,
  configValidateCommand,
  initCommand,
  versionCommand,
  type GlobalOptions,
} from './commands.js';
import { resolveConfigPath } from './config/paths.js';
import type { Deps } from './deps.js';
import { writeEnvelope, writeHumanError } from './output.js';
import { UsageError } from './errors.js';

interface RootOpts {
  json?: boolean;
  verbose?: boolean;
  yes?: boolean;
  config?: string;
}

/** Entry point shared by bin and tests: parse argv, run the command, return the exit code. */
export async function main(argv: string[], deps: Deps): Promise<number> {
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
    .description('Turn an Apple Silicon Mac mini into a headless Claude Code dev server')
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
    .description('Validate the config file')
    .action(run(() => configValidateCommand(deps, globals())));
  config
    .command('edit')
    .description('Open the config in $EDITOR and validate it afterwards')
    .action(run(() => configEditCommand(deps, globals())));

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
    if (g.json) writeEnvelope(deps, false, null, [{ code: 'internal', message: err instanceof Error ? err.message : String(err) }]);
    else writeHumanError(deps, err);
    return ExitCode.ChecksFailed;
  }
  return exit ?? ExitCode.Ok;
}
