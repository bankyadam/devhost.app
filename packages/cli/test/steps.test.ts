import { join } from 'node:path';
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
import { HELPER_PATH, helperArgs, sudoersRule } from '../src/root-helper.js';
import { rootHelperStep } from '../src/steps/root-helper.js';
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
  it('renders the Brewfile from config; mise is not in it (it has its own installer)', async () => {
    const c = config({ packages: { brew: ['git'], cask: ['iterm2'], extra: ['tap "x/y"'] } });
    expect(brewFormulae(c)).toEqual(['git', 'colima', 'docker', 'docker-compose', 'docker-buildx', 'tailscale']);
    expect(requiredPackages(c).cask).toEqual(['iterm2', 'claude-code']);
    const text = await renderBrewfile(c);
    expect(text).toContain('brew "git"\nbrew "colima"');
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

  it('only installs what is missing: outdated packages are not upgraded on every apply', async () => {
    const env = await makeEnv();
    const c = config();
    const runner = new MockRunner()
      .on('brew bundle check', {})
      .on('brew bundle install', { stdout: 'Using git\nInstalling tmux\n' });
    const ctx = { user: 'tester', brewPrefix: '/usr/local', nodePath: '/n', configPath: '/c', config: c, home: env.home, exec: exec(runner, {}, logging) };
    logs.length = 0;
    await packagesStep.apply(ctx);
    await packagesStep.check(ctx);
    const [install, check] = runner.calls;
    expect(install!.args).toEqual(['bundle', 'install', '--no-upgrade', expect.stringMatching(/^--file=.*Brewfile$/)]);
    expect(check!.args).toEqual(['bundle', 'check', '--no-upgrade', expect.stringMatching(/^--file=/)]);
    expect(check!.opts?.env).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: '1' });
    // brew's own output shows while it runs, so a long install does not look like a hang.
    expect(logs).toEqual(['  Using git', '  Installing tmux']);
  });

  it('a failed package install says how to see the real error', async () => {
    const env = await makeEnv();
    const runner = new MockRunner().on('brew bundle install', { code: 1, stderr: '==> Auto-updating Homebrew...\nInstalling tmux has failed!\nInstalling mosh has failed!\n' });
    const ctx = { user: 'tester', brewPrefix: '/usr/local', nodePath: '/n', configPath: '/c', config: config(), home: env.home, exec: exec(runner) };
    await expect(packagesStep.apply(ctx)).rejects.toMatchObject({ message: 'brew bundle could not install tmux, mosh (its output is above)', hint: 'Run `brew install tmux`, `brew install mosh` to see why, fix that, then `devhost apply` again.' });
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
    const runner = new MockRunner().on('sh -c command -v mise', { stdout: '/opt/homebrew/bin/mise\n' }).on('mise ls', { stdout: JSON.stringify({ node: [{ requested_version: 'lts', installed: true }] }) });
    const r = await runtimesStep.check({ user: 'tester', brewPrefix: '/opt/homebrew', nodePath: '/opt/homebrew/bin/node', configPath: '/c', config: config({ runtimes: { node: 'lts', python: '3.12' } }), home: '/h', exec: exec(runner) });
    expect(r).toEqual({ state: 'todo', reason: 'missing: python@3.12' });
  });

  it("installs mise with its installer, and finds it in ~/.local/bin where ssh's PATH does not look", async () => {
    const ctx = (runner: MockRunner) => ({ user: 'tester', brewPrefix: '/usr/local', nodePath: '/n', configPath: '/c', config: config({ runtimes: { node: 'lts' } }), home: '/h', exec: exec(runner) });
    const none = new MockRunner().on('sh -c curl', {}).on('/h/.local/bin/mise use', {});
    expect(await runtimesStep.check(ctx(none))).toEqual({ state: 'todo', reason: 'mise is not installed yet' });
    await runtimesStep.apply(ctx(none));
    const install = none.calls.find((c) => c.command === 'sh' && c.args[1]?.startsWith('curl'))!;
    expect(install.args).toEqual(['-c', 'curl -fsSL https://mise.run | sh']);
    expect(install.opts?.env).toEqual({ MISE_INSTALL_PATH: '/h/.local/bin/mise' });
    expect(none.lines().at(-1)).toBe('/h/.local/bin/mise use --global --yes node@lts');

    const installed = new MockRunner().on('test -x /h/.local/bin/mise', {}).on('/h/.local/bin/mise ls', { stdout: JSON.stringify({ node: [{ requested_version: 'lts', installed: true }] }) });
    expect(await runtimesStep.check(ctx(installed))).toEqual({ state: 'ok' });
  });
});

describe('step selection', () => {
  it('selects by id or group and rejects unknown names', () => {
    const all = buildSteps(config());
    expect(selectSteps(all, ['system']).map((s) => s.id)).toEqual(['system.helper', 'system.hostname', 'system.power', 'system.ssh']);
    expect(selectSteps(all, ['system.power', 'shell']).map((s) => s.id)).toEqual(['system.power', 'shell']);
    expect(selectSteps(all, ['docker']).map((s) => s.id)).toEqual(['docker.config', 'docker.runtime']);
    expect(() => selectSteps(all, ['nope'])).toThrow(/unknown step: nope/);
  });
});

describe('root helper', () => {
  const LD = '/Library/LaunchDaemons';
  it('maps devhost root commands to helper operations, and nothing else', () => {
    expect(helperArgs('launchctl', ['bootout', 'system/com.devhost.rc.a.b'], LD)).toEqual(['bootout', 'com.devhost.rc.a.b']);
    expect(helperArgs('launchctl', ['bootstrap', 'system', `${LD}/com.devhost.collector.plist`], LD)).toEqual(['bootstrap', 'com.devhost.collector']);
    expect(helperArgs('launchctl', ['kickstart', '-k', 'system/com.devhost.collector'], LD)).toEqual(['kickstart', 'com.devhost.collector', '-k']);
    expect(helperArgs('launchctl', ['kickstart', 'system/com.devhost.collector'], LD)).toEqual(['kickstart', 'com.devhost.collector']);
    expect(helperArgs('install', ['-m', '644', '-o', 'root', '-g', 'wheel', '/h/.config/devhost/launchd/com.devhost.x.plist', `${LD}/com.devhost.x.plist`], LD)).toEqual(['install', 'com.devhost.x', '/h/.config/devhost/launchd/com.devhost.x.plist']);
    expect(helperArgs('rm', ['-f', `${LD}/com.devhost.x.plist`], LD)).toEqual(['remove', 'com.devhost.x']);
    expect(helperArgs('scutil', ['--set', 'HostName', 'macmini'], LD)).toEqual(['hostname', 'HostName', 'macmini']);
    expect(helperArgs('pmset', ['-a', 'sleep', '0', 'womp', '1'], LD)).toEqual(['pmset', 'sleep', '0', 'womp', '1']);
    expect(helperArgs('systemsetup', ['-setremotelogin', 'on'], LD)).toEqual(['remote-login']);
    // Not the helper's: other services, other files, Tailscale (root daemon from a user-writable prefix), the helper itself.
    for (const [cmd, args] of [
      ['launchctl', ['bootout', 'system/com.apple.sshd']],
      ['launchctl', ['bootstrap', 'system', '/tmp/com.devhost.x.plist']],
      ['install', ['-m', '755', '-o', 'root', '-g', 'wheel', '/s', HELPER_PATH]],
      ['rm', ['-f', '/etc/sudoers.d/devhost']],
      ['brew', ['services', 'start', 'tailscale']],
      ['visudo', ['-c', '-f', '/s']],
    ] as [string, string[]][]) {
      expect(helperArgs(cmd, args, LD), `${cmd} ${args.join(' ')}`).toBeNull();
    }
  });

  it('the sudoers rule names one user and the helper only', () => {
    expect(sudoersRule('adam')).toContain(`adam ALL=(root) NOPASSWD: ${HELPER_PATH}\n`);
    expect(() => sudoersRule('root')).toThrow();
    expect(() => sudoersRule('a b')).toThrow();
  });

  it('runs root commands through the helper once sudo allows it without a password, else sudo as before', async () => {
    const runner = new MockRunner().on('sudo -n -l', {}).on('sudo -n --', {});
    const e = exec(runner, { rootHelper: { path: HELPER_PATH, launchDaemons: LD } }, logging);
    logs.length = 0;
    await e.exec('launchctl', ['kickstart', '-k', 'system/com.devhost.collector'], { sudo: true, reason: 'restart' });
    await e.exec('launchctl', ['bootout', 'system/com.devhost.collector'], { sudo: true });
    expect(runner.lines()).toEqual([`sudo -n -l ${HELPER_PATH}`, `sudo -n -- ${HELPER_PATH} kickstart com.devhost.collector -k`, `sudo -n -- ${HELPER_PATH} bootout com.devhost.collector`]);
    expect(logs.some((l) => l.includes('sudo required'))).toBe(false);
    // Tailscale is not the helper's: plain sudo (and its password).
    await e.exec('brew', ['services', 'start', 'tailscale'], { sudo: true, reason: 'tailscale' });
    expect(runner.lines().at(-1)).toBe('sudo -n -- brew services start tailscale');

    const noRule = new MockRunner().on('sudo -n -l', { code: 1, stderr: 'sudo: a password is required\n' }).on('sudo -n --', {});
    await exec(noRule, { rootHelper: { path: HELPER_PATH, launchDaemons: LD } }).exec('launchctl', ['bootout', 'system/com.devhost.collector'], { sudo: true, allowFailure: true });
    expect(noRule.lines().at(-1)).toBe('sudo -n -- launchctl bootout system/com.devhost.collector');
  });

  it('step: skipped when off, installs helper and a checked sudoers rule when on', async () => {
    const env = await makeEnv();
    const ctx = (runner: MockRunner, rootHelper: boolean) => ({ user: 'adam', brewPrefix: '/usr/local', nodePath: '/n', configPath: '/c', config: config({ machine: { hostname: 'm', rootHelper } }), home: env.home, exec: exec(runner) });
    expect(await rootHelperStep.check(ctx(new MockRunner(), false))).toEqual({ state: 'skip', reason: 'machine.rootHelper is false' });
    expect(await rootHelperStep.check(ctx(new MockRunner(), true))).toEqual({ state: 'todo', reason: 'the root helper is not installed' });
    const runner = new MockRunner().on('sudo -n --', {});
    await rootHelperStep.apply(ctx(runner, true));
    const lines = runner.lines();
    const visudo = lines.findIndex((l) => l.includes('visudo -c -f'));
    const sudoers = lines.findIndex((l) => l.includes('install -m 440 -o root -g wheel'));
    expect(lines.some((l) => l.includes('install -m 755 -o root -g wheel'))).toBe(true);
    expect(visudo).toBeGreaterThan(-1);
    expect(sudoers).toBeGreaterThan(visudo);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(env.home, '.config', 'devhost', 'root-helper', 'sudoers'), 'utf8')).toContain(`adam ALL=(root) NOPASSWD: ${HELPER_PATH}`);
  });
});

