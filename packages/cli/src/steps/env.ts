import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import {
  accountEnv,
  accountsOf,
  bridgePointerPath,
  composeProject,
  effectiveClaudeDir,
  envDir,
  environmentsOf,
  rcLabel,
  rcLogPath,
  type Account,
  type Environment,
} from '../config/accounts.js';
import { applyDaemon, checkDaemon, daemonInstalled, removeDaemon, serviceEnv, type DaemonSpec } from '../launchd.js';
import { toolPath } from '../state.js';
import { sleepState } from '../sleep.js';
import { onVolume, workVolumeOf } from '../storage/volume.js';
import { DevhostError } from '../errors.js';
import { isKeychainError, keychainFreeDockerConfig } from '../docker-creds.js';
import { ok, todo, type EnvInfo, type Step, type StepContext } from './types.js';

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

export function envrcFor(account: string, env: string, portBase: number): string {
  return [
    '# Managed by devhost; excluded from git via .git/info/exclude.',
    'source_up_if_exists                       # inherits the account\'s CLAUDE_CONFIG_DIR',
    `export DEVHOST_PORT_BASE=${portBase}`,
    `export OTEL_RESOURCE_ATTRIBUTES="devhost.account=${account},devhost.env=${env}"`,
    '',
  ].join('\n');
}

export function envInfoOf(a: Account, e: Environment, home: string): EnvInfo {
  return {
    name: e.name,
    account: a.name,
    dir: envDir(a, e, home),
    claudeConfigDir: accountEnv(a, home)['CLAUDE_CONFIG_DIR'] ?? null,
    spawn: e.remoteControl?.spawn ?? 'worktree',
    permissionMode: e.remoteControl?.permissionMode ?? 'acceptEdits',
  };
}

/** What Remote Control talks to; services wait for it to resolve before starting (boot). */
export const CLAUDE_API_HOST = 'api.anthropic.com';

export async function rcSpec(ctx: StepContext, a: Account, e: Environment): Promise<DaemonSpec> {
  const info = envInfoOf(a, e, ctx.home);
  const claude = await toolPath(ctx.exec, ctx.home, 'claudePath', 'claude', `${ctx.brewPrefix}/bin/claude`);
  const pointer = bridgePointerPath(a, info.dir, ctx.home);
  return {
    label: rcLabel(a.name, e.name),
    args: [claude, 'remote-control', '--name', `${a.name}-${e.name}`, '--spawn', info.spawn, '--permission-mode', info.permissionMode],
    workingDirectory: info.dir,
    env: serviceEnv(ctx.home, {
      ...accountEnv(a, ctx.home),
      DEVHOST_PORT_BASE: String(e.portBase ?? 0),
      OTEL_RESOURCE_ATTRIBUTES: `devhost.account=${a.name},devhost.env=${e.name}`,
    }),
    logPath: rcLogPath(ctx.home, a.name, e.name),
    throttle: 30,
    waitForHost: CLAUDE_API_HOST,
    // After a long stop (a night off) the service reattaches to its environment and session.
    ...(pointer ? { pointer: { path: pointer, seen: join(ctx.home, '.local', 'share', 'devhost', 'rc', `${rcLabel(a.name, e.name)}.pointer`) } } : {}),
    // Only environments on the work volume wait for it; every other plist stays as it was (spec A7).
    ...(onVolume(workVolumeOf(ctx.config), info.dir) ? { gate: storageGate(ctx) } : {}),
  };
}

/** `devhost storage wait` as a service runs it (the installed wrapper, this config). */
export const storageGate = (ctx: Pick<StepContext, 'brewPrefix' | 'configPath'>): string[] => [`${ctx.brewPrefix}/bin/devhost`, 'storage', 'wait', '--timeout', '120', '--config', ctx.configPath];

/** Best effort: Claude Code keeps `projects[<dir>].hasTrustDialogAccepted` in its state file. */
export async function workspaceTrusted(ctx: StepContext, a: Account, dir: string): Promise<boolean> {
  const stateFile = a.configDir ? join(effectiveClaudeDir(a, ctx.home), '.claude.json') : join(ctx.home, '.claude.json');
  const text = await ctx.exec.readText(stateFile);
  if (text === null) return false;
  try {
    const projects = (JSON.parse(text) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects ?? {};
    let p = dir;
    for (;;) {
      if (projects[p]?.hasTrustDialogAccepted === true) return true;
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (parent === '' || parent === p) return false;
      p = parent;
    }
  } catch {
    return false;
  }
}

async function composeFile(ctx: StepContext, dir: string): Promise<string | null> {
  for (const f of COMPOSE_FILES) {
    if ((await ctx.exec.readText(join(dir, f))) !== null) return join(dir, f);
  }
  return null;
}

/**
 * The compose project's containers: up when at least one runs (or is paused on purpose) and every
 * other one ran to completion (exit 0), like a one-shot init service that creates buckets or runs migrations.
 */
export async function composeState(exec: StepContext['exec'], name: string, dir: string): Promise<{ up: boolean; running: number }> {
  const r = await exec.query('docker', ['compose', '-p', composeProject(name), 'ps', '-a', '--format', '{{.State}} {{.ExitCode}}'], { cwd: dir });
  const rows = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const isUp = (l: string): boolean => l.startsWith('running ') || l.startsWith('paused ');
  const running = rows.filter(isUp).length;
  return { up: r.code === 0 && running > 0 && rows.every((l) => isUp(l) || l === 'exited 0'), running };
}

async function composeUp(ctx: StepContext, e: Environment, dir: string): Promise<boolean> {
  return (await composeState(ctx.exec, e.name, dir)).up;
}

/**
 * `docker compose up` failed. A network left from an earlier run or another project is the usual
 * cause (compose refuses one it did not create for this project); devhost never removes it, since
 * something else may use it, but says how to.
 */
export function composeError(a: Account, e: Environment, code: number, stderr: string, serviceUp = false): DevhostError {
  const network = /network (?:with name )?["']?([\w.-]+)["']? (?:already exists|was found but|exists but)/i.exec(stderr)?.[1];
  const again = `then run the setup again: devhost env create --account ${a.name} --name ${e.name} (the app: Environments → … → Run setup again)${serviceUp ? `. The environment's Remote Control service runs already: a session in ${e.name} on claude.ai can fix it` : ''}`;
  const detail = stderr.trim().split('\n').filter(Boolean).at(-1) ?? `exit ${code}`;
  return network
    ? new DevhostError(`docker compose could not create the network "${network}": it exists already (${detail})`, 'compose-network-exists', 1, `See what uses it: docker network inspect ${network}. If nothing does: docker network rm ${network}, ${again}.`)
    : new DevhostError(`docker compose up failed for ${e.name}: ${detail}`, 'compose-failed', 1, `Fix the compose project in ${e.name}, ${again}.`);
}

/** Is `dir` itself a repository's top level (not just somewhere inside another one, say a repository in the home directory)? */
export async function isGitRepo(ctx: StepContext, dir: string): Promise<boolean> {
  const r = await ctx.exec.query('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (r.code !== 0) return false;
  const top = r.stdout.trim();
  if (top === '') return true;
  const real = await realpath(dir).catch(() => dir);
  return top === dir || top === real || (await realpath(top).catch(() => top)) === real;
}

/** A directory devhost made before the repository was there: only `.envrc` and `.claude/agents`. */
async function holdsOnlyDevhostFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null);
  if (entries === null || entries.length === 0) return false;
  if (!entries.every((n) => n === '.envrc' || n === '.claude')) return false;
  if (!entries.includes('.claude')) return true;
  return (await readdir(join(dir, '.claude')).catch(() => ['?'])).every((n) => n === 'agents');
}

/**
 * Does the repository have a commit? An empty one (`git init`, or a clone of an empty remote) has
 * an unborn HEAD, and Remote Control's `--spawn worktree` cannot start any session from it ("Failed
 * to resolve base branch HEAD").
 */
export async function hasCommit(exec: StepContext['exec'], dir: string): Promise<boolean> {
  return (await exec.query('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
}

/** Worktree sessions need a commit to branch from: an empty repository gets an empty first commit (local only, never pushed). */
const needsFirstCommit = (e: Environment): boolean => e.remoteControl?.enabled !== false && (e.remoteControl?.spawn ?? 'worktree') === 'worktree';

export function envStep(a: Account, e: Environment): Step {
  const id = `env.${e.name}`;
  return {
    id,
    description: `Environment ${a.name}/${e.name}: repo, ports, compose, Remote Control service`,
    independent: true,
    async check(ctx) {
      const dir = envDir(a, e, ctx.home);
      const problems: string[] = [];
      const rcEnabled = e.remoteControl?.enabled !== false;

      if (!(await isGitRepo(ctx, dir))) problems.push(`${dir} is not a git repository`);
      else {
        const base = e.portBase ?? 0;
        if ((await ctx.exec.readText(join(dir, '.envrc'))) !== envrcFor(a.name, e.name, base)) problems.push('.envrc');
        else if (!/Found RC allowed 0/.test((await ctx.exec.query('direnv', ['status'], { cwd: dir })).stdout)) problems.push('.envrc is not allowed in direnv');
        const exclude = (await ctx.exec.readText(join(dir, '.git', 'info', 'exclude'))) ?? '';
        if (!exclude.split('\n').includes('.envrc')) problems.push('.envrc is not git-excluded');
        if (e.compose !== 'off' && (await composeFile(ctx, dir)) && !(await sleepState(ctx.home, e.name)) && !(await composeUp(ctx, e, dir))) problems.push('compose services are not up');
        if (needsFirstCommit(e) && !(await hasCommit(ctx.exec, dir))) problems.push('the repository has no commit: worktree sessions cannot start');
      }

      if (rcEnabled) {
        const svc = await checkDaemon(ctx, await rcSpec(ctx, a, e));
        if (svc.state === 'todo') problems.push(svc.reason);
        else if (!(await workspaceTrusted(ctx, a, dir))) {
          ctx.exec.warn(`${a.name}/${e.name}: workspace trust is not recorded; if the service exits with "Workspace not trusted", run \`devhost login ${a.name}\`.`);
        }
      } else if (await daemonInstalled(ctx.exec, rcLabel(a.name, e.name))) {
        problems.push('the Remote Control service should be removed (remoteControl.enabled is false)');
      }
      return problems.length === 0 ? ok() : todo(problems.join('; '));
    },
    async apply(ctx) {
      const { exec } = ctx;
      const dir = envDir(a, e, ctx.home);
      const base = e.portBase ?? 0;

      if (!(await isGitRepo(ctx, dir))) {
        if (e.repo && (await exec.query('test', ['-d', dir])).code !== 0) {
          await exec.mkdirp(join(dir, '..'));
          // `--` so a repo value starting with '-' can never be read as a git option.
          await exec.exec('git', ['clone', '--', e.repo, dir], { reason: `clone ${e.repo}` });
        } else if (e.repo && (await holdsOnlyDevhostFiles(dir))) {
          // `git clone` refuses a directory that is not empty: clone beside it and move the repository in.
          const tmp = `${dir}.devhost-clone`;
          await exec.remove(tmp, { recursive: true });
          await exec.exec('git', ['clone', '--no-checkout', '--', e.repo, tmp], { reason: `clone ${e.repo}` });
          await exec.exec('mv', [join(tmp, '.git'), join(dir, '.git')]);
          await exec.remove(tmp, { recursive: true });
          // An empty remote has nothing to check out.
          await exec.exec('git', ['-C', dir, 'checkout', '--force', '--quiet', 'HEAD'], { allowFailure: true });
        } else {
          await exec.mkdirp(dir);
          await exec.exec('git', ['init', dir]);
        }
      }
      if (needsFirstCommit(e) && !(await hasCommit(exec, dir))) {
        // The account's git identity applies (includeIf on the account root); nothing is pushed.
        await exec.exec('git', ['-C', dir, 'commit', '--allow-empty', '--quiet', '-m', 'Initial commit'], { reason: 'an empty repository: worktree sessions need a commit to branch from' });
      }
      await exec.writeText(join(dir, '.envrc'), envrcFor(a.name, e.name, base), { description: `write ${join(dir, '.envrc')}` });
      const excludeFile = join(dir, '.git', 'info', 'exclude');
      const exclude = (await exec.readText(excludeFile)) ?? '';
      if (!exclude.split('\n').includes('.envrc')) {
        await exec.mkdirp(join(dir, '.git', 'info'));
        await exec.writeText(excludeFile, `${exclude}${exclude === '' || exclude.endsWith('\n') ? '' : '\n'}.envrc\n`, { description: `exclude .envrc in ${excludeFile}` });
      }
      await exec.exec('direnv', ['allow', dir]);

      let composeFailed: { code: number; stderr: string } | null = null;
      // Asleep (A7.9): its services start when a session uses it, not here.
      if (e.compose !== 'off' && (await composeFile(ctx, dir)) && !(await sleepState(ctx.home, e.name))) {
        const composeUp = (env?: Record<string, string>) =>
          exec.exec('docker', ['compose', '-p', composeProject(e.name), 'up', '-d'], { cwd: dir, reason: 'start the environment\'s compose services', allowFailure: true, progress: true, ...(env ? { env } : {}) });
        let up = await composeUp();
        if (up.code !== 0 && isKeychainError(up.stderr)) {
          // Docker Desktop's credential helper needs the Keychain, which this session (ssh, no GUI login) cannot use.
          const config = await keychainFreeDockerConfig(exec, ctx.home);
          if (config) {
            exec.warn('Docker\'s credential helper needs the macOS Keychain, which is locked to this session: pulling without it (public images only).');
            up = await composeUp({ DOCKER_CONFIG: config });
          }
        }
        // Reported once the service runs: a session in the environment is how its compose project gets fixed.
        if (up.code !== 0) composeFailed = up;
      }

      if (e.remoteControl?.enabled === false) {
        await removeDaemon(ctx, rcLabel(a.name, e.name));
      } else {
        if (ctx.beforeService) await ctx.beforeService(envInfoOf(a, e, ctx.home));
        await applyDaemon(ctx, await rcSpec(ctx, a, e));
      }
      if (composeFailed) throw composeError(a, e, composeFailed.code, composeFailed.stderr, e.remoteControl?.enabled !== false);
    },
  };
}

export function envSteps(config: DevhostConfig): Step[] {
  return environmentsOf(config).flatMap((e) => {
    const a = accountsOf(config).find((x) => x.name === e.account);
    return a ? [envStep(a, e)] : [];
  });
}

