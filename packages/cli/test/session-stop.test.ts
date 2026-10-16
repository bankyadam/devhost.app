import { describe, expect, it } from 'vitest';
import { validateConfig } from '@devhost/contract';
import { parsePs, sessionStop } from '../src/plugins/builtin/session-stop.js';
import { pluginContext } from '../src/plugins/context.js';
import type { Reporter } from '../src/reporter.js';
import { Executor } from '../src/runner/executor.js';
import { MockRunner } from '../src/runner/mock.js';
import { NoPrompter } from '../src/prompter.js';

const silent: Reporter = { step: () => undefined, log: () => undefined };
const WT = '/Users/x/work/b/api/.claude/worktrees/bridge-cse_01';

function setup(ps: string, opts: { killWorks?: boolean } = {}) {
  const r = validateConfig({
    machine: { hostname: 'm' },
    notify: { topic: 'devhost-abcdefgh' },
    accounts: [{ name: 'b', root: '/Users/x/work/b', configDir: '/Users/x/.claude-b', portRange: [4000, 4999], git: { name: 'A', email: 'a@b.c' } }],
    environments: [{ name: 'api', account: 'b', portBase: 4000 }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  let alive = true;
  const runner = new MockRunner()
    .on('launchctl print system/com.devhost.rc.b.api', { stdout: 'state = running\n\tpid = 100\n' })
    .on('ps -axo', { stdout: ps })
    .on('lsof -a -p 200', { stdout: `p200\nn${WT}\n` })
    .on('lsof -a -p 201', { stdout: 'p201\nn/Users/x/work/b/api/.claude/worktrees/other\n' })
    .on('lsof -a -p 300', { stdout: `p300\nn${WT}\n` })
    .on('kill -TERM', () => {
      if (opts.killWorks !== false) alive = false;
      return {};
    })
    .on('kill -KILL', () => {
      alive = false;
      return {};
    })
    .on('kill -0', () => ({ code: alive ? 0 : 1 }));
  const exec = new Executor(runner, silent, { dryRun: false, verbose: false, interactiveSudo: false, now: () => new Date(), sleep: async () => undefined });
  const ctx = pluginContext({ config: r.value, name: 'session-stop', home: '/Users/x', user: 'x', nodePath: '/n', exec, reporter: silent, prompter: new NoPrompter() });
  return { ctx, runner };
}

const session = { id: '6a7802e0-1fdb-5b42-97c0-58f0601c2628', account: 'b', env: 'api', cwd: WT };
const stop = sessionStop.actions![0]!;

describe('session-stop plugin', () => {
  it("stops only the Remote Control service's child working in the session's directory", async () => {
    // 200: the session; 201: another session of the service; 300: the Claude app's, same directory.
    const { ctx, runner } = setup(' 200 100 400000 /usr/local/bin/claude --print --session-id cse_01\n 201 100 300000 /usr/local/bin/claude --print --session-id cse_02\n 300 999 500000 /Applications/Claude.app/claude\n');
    const r = await stop.run(ctx, { session });
    expect(r.summary).toBe('stopped session 6a7802e0 (pid 200, 391 MB freed)');
    expect(runner.lines().filter((l) => l.startsWith('kill -TERM') || l.startsWith('kill -KILL'))).toEqual(['kill -TERM 200']);
  });

  it('SIGKILL when it does not end; nothing when there is no such process', async () => {
    const stubborn = setup(' 200 100 1024 /usr/local/bin/claude --print\n', { killWorks: false });
    expect((await stop.run(stubborn.ctx, { session })).summary).toContain('with SIGKILL');
    const none = setup(' 300 999 1024 /Applications/Claude.app/claude\n');
    expect((await stop.run(none.ctx, { session })).summary).toContain('has no process of a devhost Remote Control service');
    expect(none.runner.lines().some((l) => l.startsWith('kill -'))).toBe(false);
    expect(parsePs('  12   1 2048 /bin/zsh -l\nbad line\n')).toEqual([{ pid: 12, ppid: 1, rssKb: 2048, command: '/bin/zsh -l' }]);
  });
});
