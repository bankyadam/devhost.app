import { describe, expect, it } from 'vitest';
import type { DevhostConfig } from '@devhost/contract';
import { validateConfig } from '@devhost/contract';
import { HumanActionRequired, CommandError } from '../src/errors.js';
import { Executor } from '../src/runner/executor.js';
import { MockRunner } from '../src/runner/mock.js';
import type { Reporter } from '../src/reporter.js';
import { brewFormulae, packagesStep, renderBrewfile, requiredPackages } from '../src/steps/packages.js';
import { installedRequests, runtimesStep } from '../src/steps/runtimes.js';
import { pmsetCapabilities, pmsetValues, powerStep, sshStep, hostnameStep } from '../src/steps/system.js';
import { buildSteps, selectSteps } from '../src/steps/index.js';
import { makeEnv } from './helpers.js';

const config = (extra: object = {}): DevhostConfig => {
  const r = validateConfig({ machine: { hostname: 'macmini' }, notify: { topic: 'devhost-abcdefgh' }, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};

const silent: Reporter = { step: () => undefined, log: () => undefined };
const logs: string[] = [];
const logging: Reporter = { step: () => undefined, log: (_l, m) => logs.push(m) };

function exec(runner: MockRunner, opts: Partial<ConstructorParameters<typeof Executor>[2]> = {}, reporter = silent): Executor {
  return new Executor(runner, reporter, { dryRun: false, verbose: false, interactiveSudo: false, now: () => new Date(), ...opts });
}

describe('Executor', () => {
  it('records the plan and runs nothing mutating in a dry-run, but still answers queries', async () => {
    const runner = new MockRunner().on('scutil --get', { stdout: 'x\n' });
    const e = exec(runner, { dryRun: true });
    e.beginStep('t');
    await e.query('scutil', ['--get', 'HostName']);
    await e.exec('pmset', ['-a', 'sleep', '0'], { sudo: true, reason: 'because' });
    await e.writeText('/nonexistent/dir/file', 'x');
    expect(runner.lines()).toEqual(['scutil --get HostName']);
    expect(e.plan).toEqual([
      { stepId: 't', action: 'sudo pmset -a sleep 0', sudo: true, reason: 'because' },
      { stepId: 't', action: 'write /nonexistent/dir/file', sudo: false },
    ]);
  });

  it('announces sudo with its reason and uses `sudo -n` when no terminal is available', async () => {
    logs.length = 0;
    const runner = new MockRunner().on('sudo', {});
    await exec(runner, {}, logging).exec('pmset', ['-a', 'sleep', '0'], { sudo: true, reason: 'keep it awake' });
    expect(logs).toEqual(['sudo required: keep it awake']);
    expect(runner.lines()).toEqual(['sudo -n -- pmset -a sleep 0']);
  });

  it('lets sudo prompt for a password when a terminal is attached', async () => {
    const runner = new MockRunner().on('sudo', {});
    await exec(runner, { interactiveSudo: true }).exec('pmset', ['-a', 'sleep', '0'], { sudo: true });
    expect(runner.lines()).toEqual(['sudo -- pmset -a sleep 0']);
    expect(runner.calls[0]?.opts?.interactive).toBe(true);
  });

  it('turns a missing sudo password into a human-action error (exit 3)', async () => {
    const runner = new MockRunner().on('sudo', { code: 1, stderr: 'sudo: a password is required' });
    await expect(exec(runner).exec('pmset', [], { sudo: true })).rejects.toBeInstanceOf(HumanActionRequired);
  });

  it('throws CommandError on failure unless allowed', async () => {
    const runner = new MockRunner().on('brew', { code: 1, stderr: 'boom\nmore' });
    await expect(exec(runner).exec('brew', ['x'])).rejects.toBeInstanceOf(CommandError);
    await expect(exec(runner).exec('brew', ['x'], { allowFailure: true })).resolves.toMatchObject({ code: 1 });
  });
});

describe('system steps', () => {
  it('hostname: ok only when all three names match', async () => {
    const runner = new MockRunner().on(/^scutil --get/, { stdout: 'macmini\n' });
    expect(await hostnameStep.check({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: config(), home: '/h', exec: exec(runner) })).toEqual({ state: 'ok' });
    const other = new MockRunner().on('scutil --get LocalHostName', { stdout: 'other\n' }).on(/^scutil --get/, { stdout: 'macmini\n' });
    const r = await hostnameStep.check({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: config(), home: '/h', exec: exec(other) });
    expect(r).toMatchObject({ state: 'todo', reason: expect.stringContaining('LocalHostName') });
  });

  it('power: parses pmset output', () => {
    const out = 'AC Power:\n sleep                0 (sleep prevented by powerd)\n disksleep            10\n womp 1\n';
    expect(pmsetValues(out, 'sleep')).toEqual([0]);
    expect(pmsetValues(out, 'disksleep')).toEqual([10]);
    expect(pmsetValues(out, 'autorestart')).toEqual([]);
  });

  it('power: parses pmset capabilities (a MacBook has no autorestart)', () => {
    const caps = pmsetCapabilities('Capabilities for AC Power:\n displaysleep\n disksleep\n sleep\n womp\n lidwake\n');
    expect(caps).toEqual(new Set(['displaysleep', 'disksleep', 'sleep', 'womp', 'lidwake']));
    expect(pmsetCapabilities('')).toBeNull();
  });

  it('power: only manages settings the config enables', async () => {
    const c = config({ machine: { hostname: 'macmini', power: { neverSleep: false, autoRestartAfterPowerLoss: true, wakeOnLan: false } } });
    const runner = new MockRunner();
    const e = exec(runner, { dryRun: true });
    await powerStep.apply({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: c, home: '/h', exec: e });
    expect(e.plan[0]?.action).toBe('sudo pmset -a autorestart 1');
    const none = config({ machine: { hostname: 'macmini', power: { neverSleep: false, autoRestartAfterPowerLoss: false, wakeOnLan: false } } });
    expect(await powerStep.check({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: none, home: '/h', exec: exec(runner) })).toMatchObject({ state: 'skip' });
  });

  it('ssh: skipped when disabled; Full Disk Access becomes manual steps', async () => {
    expect(await sshStep.check({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: config({ network: { ssh: false } }), home: '/h', exec: exec(new MockRunner()) })).toMatchObject({ state: 'skip' });
    const runner = new MockRunner().on('sudo', { code: 1, stderr: 'setremotelogin: Turning Remote Login on or off requires Full Disk Access privileges.' });
    const err = await sshStep.apply({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: config(), home: '/h', exec: exec(runner) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HumanActionRequired);
    expect((err as HumanActionRequired).hint).toContain('Full Disk Access');
    expect((err as HumanActionRequired).hint).toContain('Remote Login');
  });
});

describe('packages', () => {
  it('renders the Brewfile from config, adding mise when runtimes are requested', async () => {
    const c = config({ packages: { brew: ['git'], cask: ['iterm2'], extra: ['tap "x/y"'] } });
    expect(brewFormulae(c)).toEqual(['git', 'mise', 'colima', 'docker', 'docker-compose', 'docker-buildx', 'tailscale']);
    expect(requiredPackages(c).cask).toEqual(['iterm2', 'claude-code']);
    const text = await renderBrewfile(c);
    expect(text).toContain('brew "git"\nbrew "mise"\nbrew "colima"');
    expect(text).toContain('cask "iterm2"\ncask "claude-code"\ntap "x/y"\n');
    expect(text).not.toContain('&quot;');
    const bare = config({ packages: { brew: ['git'] }, runtimes: {}, docker: { runtime: 'none' }, network: { tailscale: false }, claude: { install: 'native' } });
    expect(requiredPackages(bare)).toEqual({ brew: ['git'], cask: [] });
  });

  it('is todo until the Brewfile is written and bundle check passes', async () => {
    const env = await makeEnv();
    const c = config();
    const ctx = (runner: MockRunner) => ({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: c, home: env.home, exec: exec(runner) });
    expect(await packagesStep.check(ctx(new MockRunner()))).toMatchObject({ state: 'todo' });
    const e = exec(new MockRunner().on('brew bundle', {}));
    await packagesStep.apply({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: c, home: env.home, exec: e });
    expect(await packagesStep.check(ctx(new MockRunner().on('brew bundle check', {})))).toEqual({ state: 'ok' });
    expect(await packagesStep.check(ctx(new MockRunner().on('brew bundle check', { code: 1 })))).toMatchObject({ state: 'todo' });
    expect(await packagesStep.check(ctx(new MockRunner()))).toMatchObject({ reason: expect.stringContaining('Homebrew is not installed') });
  });
});

describe('runtimes', () => {
  it('parses mise output defensively', () => {
    expect(installedRequests('not json')).toBeNull();
    expect(installedRequests('[]')).toBeNull();
    const m = installedRequests(JSON.stringify({ node: [{ requested_version: 'lts', installed: true }, { requested_version: '20', installed: false }] }));
    expect([...(m?.get('node') ?? [])]).toEqual(['lts']);
  });

  it('lists what is missing', async () => {
    const runner = new MockRunner().on('mise ls', { stdout: JSON.stringify({ node: [{ requested_version: 'lts', installed: true }] }) });
    const r = await runtimesStep.check({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: config({ runtimes: { node: 'lts', python: '3.12' } }), home: '/h', exec: exec(runner) });
    expect(r).toEqual({ state: 'todo', reason: 'missing: python@3.12' });
  });
});

describe('step selection', () => {
  it('selects by id or group and rejects unknown names', () => {
    const all = buildSteps(config());
    expect(selectSteps(all, ['system']).map((s) => s.id)).toEqual(['system.hostname', 'system.power', 'system.ssh']);
    expect(selectSteps(all, ['system.power', 'shell']).map((s) => s.id)).toEqual(['system.power', 'shell']);
    expect(selectSteps(all, ['docker']).map((s) => s.id)).toEqual(['docker.config', 'docker.runtime']);
    expect(() => selectSteps(all, ['nope'])).toThrow(/unknown step: nope/);
  });
});
