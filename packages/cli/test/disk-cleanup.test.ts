import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '@devhost/contract';
import { diskCleanup } from '../src/plugins/builtin/disk-cleanup.js';
import { pluginContext } from '../src/plugins/context.js';
import type { Reporter } from '../src/reporter.js';
import { Executor } from '../src/runner/executor.js';
import { MockRunner } from '../src/runner/mock.js';
import { NoPrompter } from '../src/prompter.js';

const silent: Reporter = { step: () => undefined, log: () => undefined };
const DAY = 86_400_000;

async function setup(dryRun = false) {
  const home = await mkdtemp(join(tmpdir(), 'clean-'));
  const env = join(home, 'work', 'b', 'api');
  const wt = (n: string) => join(env, '.claude', 'worktrees', n);
  for (const n of ['old', 'dirty', 'unpushed', 'busy', 'fresh']) await mkdir(wt(n), { recursive: true });
  const r = validateConfig({
    machine: { hostname: 'm' },
    notify: { topic: 'devhost-abcdefgh' },
    accounts: [{ name: 'b', root: join(home, 'work', 'b'), configDir: join(home, '.claude-b'), portRange: [4000, 4999], git: { name: 'A', email: 'a@b.c' } }],
    environments: [{ name: 'api', account: 'b', portBase: 4000 }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const now = Date.now();
  const runner = new MockRunner()
    .on('brew --cache', { stdout: '/Users/x/Library/Caches/Homebrew\n' })
    .on('du -sk /Users/x/Library/Caches/Homebrew', { stdout: '2097152\t/Users/x/Library/Caches/Homebrew\n' })
    .on('npm config get cache', { stdout: '/Users/x/.npm\n' })
    .on('du -sk /Users/x/.npm/_cacache', { stdout: '1048576\t/Users/x/.npm/_cacache\n' })
    .on(/^du -sk .*worktrees/, { stdout: '4194304\tx\n' })
    .on('lsof', { stdout: `p1\nn${wt('busy')}/src\n` })
    .on(/git -C .*dirty status/, { stdout: ' M a.ts\n' })
    .on(/git -C .* status --porcelain/, { stdout: '' })
    .on(/git -C .*unpushed rev-list/, { stdout: '2\n' })
    .on(/git -C .* rev-list/, { stdout: '0\n' })
    .on(/git -C .* rev-parse --git-path index/, (c) => ({ stdout: `${c.args[1]}/.git-index\n` }))
    .on(/stat -f %m .*fresh/, { stdout: `${Math.floor((now - 3_600_000) / 1000)}\n` })
    .on(/stat -f %m /, { stdout: `${Math.floor((now - 3 * DAY) / 1000)}\n` })
    .on('brew cleanup', {})
    .on('npm cache clean', {})
    .on(/git -C .* worktree remove/, {});
  const exec = new Executor(runner, silent, { dryRun, verbose: false, interactiveSudo: false, now: () => new Date() });
  const ctx = pluginContext({ config: r.value, name: 'disk-cleanup', home, user: 'x', nodePath: '/nowhere/node', exec, reporter: silent, prompter: new NoPrompter() });
  return { ctx, runner, exec, wt };
}

const action = (id: string) => diskCleanup.actions!.find((a) => a.id === id)!;

describe('disk-cleanup plugin', () => {
  it('reports caches and which worktrees could go, saying why the others stay', async () => {
    const { ctx, wt } = await setup();
    const r = await action('report').run(ctx, {});
    expect(r.summary.split('\n')[0]).toBe('7.0 GB reclaimable: Homebrew cache 2.0 GB, npm cache 1.0 GB, 1 old worktree(s) 4.0 GB');
    const keep = Object.fromEntries((r.data!['worktrees'] as { path: string; keep?: string }[]).map((w) => [w.path.split('/').at(-1), w.keep ?? null]));
    expect(keep).toEqual({ busy: 'a process is working in it', dirty: 'it has uncommitted changes', fresh: 'used in the last 24 h', old: null, unpushed: '2 commit(s) not on any remote' });
    expect(wt('old')).toContain('.claude/worktrees/old');
  });

  it('clean empties the caches and removes only the worktree that can go, without --force', async () => {
    const { ctx, runner, wt } = await setup();
    await action('clean').run(ctx, {});
    const mutating = runner.lines().filter((l) => /brew cleanup|npm cache clean|worktree remove/.test(l));
    expect(mutating).toEqual(['brew cleanup -s --prune=all', 'npm cache clean --force', `git -C ${ctx.environments[0]!.dir} worktree remove ${wt('old')}`]);
  });

  it('a dry run only plans, and the check warns above warnGiB', async () => {
    const { ctx, runner, exec } = await setup(true);
    await action('clean').run(ctx, {});
    expect(runner.lines().some((l) => /brew cleanup|worktree remove/.test(l))).toBe(false);
    expect(exec.plan.map((p) => p.action)).toContain('brew cleanup -s --prune=all');
    expect(await diskCleanup.checks![0]!.run(ctx)).toMatchObject({ status: 'warn', fix: 'devhost plugin run disk-cleanup clean' });
    expect(await diskCleanup.checks![0]!.run({ ...ctx, options: { warnGiB: 50 } })).toMatchObject({ status: 'ok' });
  });
});
