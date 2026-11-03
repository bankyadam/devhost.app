import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validateConfig, ExitCode } from '@devhost/contract';
import { long } from '../src/command-support.js';
import { CommandError, HumanActionRequired } from '../src/errors.js';
import { HELPER_PATH, sudoersRule } from '../src/root-helper.js';
import { Executor } from '../src/runner/executor.js';
import { MockRunner } from '../src/runner/mock.js';
import { RealRunner, defaultTimeoutMs } from '../src/runner/real.js';
import { removePassphrase, setPassphrase } from '../src/storage/root.js';
import { fakeMac, makeEnv, type TestEnv } from './helpers.js';

const silent = { log() {}, step() {}, event() {} } as never;
const exec = (runner: MockRunner, o: Partial<ConstructorParameters<typeof Executor>[2]> = {}) =>
  new Executor(runner, silent, { dryRun: false, verbose: false, interactiveSudo: false, now: () => new Date(), ...o });
const LD = '/Library/LaunchDaemons';

async function converged() {
  const mac = fakeMac();
  const env = await makeEnv(mac.runner);
  await env.run('init', '--yes', '--no-tailscale');
  await env.run('apply');
  env.out.length = 0;
  return { env, mac };
}
const configPath = (env: TestEnv) => join(env.home, '.config', 'devhost', 'config.yaml');

describe('CLI-8: secrets operations need the sudo password, not the NOPASSWD rule', () => {
  it('the sudoers rule resets the environment and asks a password for the three operations', () => {
    const rule = sudoersRule('adam');
    expect(rule).toContain('Defaults:adam env_reset');
    expect(rule).toContain(`adam ALL=(root) NOPASSWD: ${HELPER_PATH}\n`);
    const pw = rule.split('\n').find((l) => l.includes('PASSWD:') && !l.includes('NOPASSWD'))!;
    for (const op of ['set-passphrase', 'remove-passphrase', 'unlock-daemon-remove']) expect(pw).toContain(`${HELPER_PATH} ${op}`);
    // Later lines win in sudoers: the password rule comes after the NOPASSWD one.
    expect(rule.indexOf(pw)).toBeGreaterThan(rule.indexOf('NOPASSWD'));
  });

  it('asks for the password (sudo -v) and never runs these through sudo -n alone', async () => {
    const runner = new MockRunner().on('sudo', {});
    const e = exec(runner, { interactiveSudo: true, rootHelper: { path: HELPER_PATH, launchDaemons: LD } });
    await removePassphrase(e);
    await setPassphrase(e, 'pw');
    const lines = runner.lines();
    expect(lines.indexOf('sudo -v')).toBeGreaterThan(-1);
    expect(lines.indexOf('sudo -v')).toBeLessThan(lines.indexOf(`sudo -n -- ${HELPER_PATH} remove-passphrase`));
    expect(lines.filter((l) => l === 'sudo -v')).toHaveLength(2);
    expect(runner.calls.find((c) => c.args.includes('set-passphrase'))!.opts?.input).toBe('pw\n');
  });

  it('without a terminal it is a human action, not a silent passwordless run', async () => {
    const runner = new MockRunner().on('sudo', {});
    const e = exec(runner, { interactiveSudo: false, rootHelper: { path: HELPER_PATH, launchDaemons: LD } });
    await expect(setPassphrase(e, 'pw')).rejects.toBeInstanceOf(HumanActionRequired);
    expect(runner.lines().some((l) => l.includes('set-passphrase'))).toBe(false);
  });
});

describe('CLI-7: orphaned services', () => {
  it('apply removes devhost services nothing in the config wants, after asking', async () => {
    const { env, mac } = await converged();
    const orphan = 'com.devhost.rc.business.gone';
    const file = join(env.home, 'LaunchDaemons', `${orphan}.plist`);
    await writeFile(file, '<plist/>');
    mac.state.loaded.add(orphan);
    expect(await env.run('apply', '--dry-run')).toBe(0);
    expect(env.stdout()).toContain(orphan);
    expect(existsSync(file)).toBe(true);

    // No terminal and no --yes: it asks, so it is a human step.
    expect(await env.run('apply')).toBe(3);
    expect(existsSync(file)).toBe(true);
    // The collector, which the config wants, stays.
    expect(await env.run('apply', '--yes')).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(mac.state.loaded.has(orphan)).toBe(false);
    expect(mac.state.loaded.has('com.devhost.collector')).toBe(true);
  });

  it('uninstall removes them too', async () => {
    const { env, mac } = await converged();
    const orphan = 'com.devhost.colima';
    await writeFile(join(env.home, 'LaunchDaemons', `${orphan}.plist`), '<plist/>');
    mac.state.loaded.add(orphan);
    expect(await env.run('uninstall', '--yes', '--keep-packages')).toBe(0);
    expect(existsSync(join(env.home, 'LaunchDaemons', `${orphan}.plist`))).toBe(false);
    expect(mac.state.loaded.has(orphan)).toBe(false);
  });
});

describe('CLI-9: roots', () => {
  it('an account root is absolute or under ~/', () => {
    const base = { machine: { hostname: 'm' }, accounts: [{ name: 'a', root: 'work/a', gitEmail: 'a@b.c', portRange: [41000, 41999] }] };
    expect(validateConfig(base).ok).toBe(false);
    const rootErrors = (root: string) => JSON.stringify(validateConfig({ ...base, accounts: [{ ...base.accounts[0], root }] })).includes('root');
    expect(rootErrors('work/a')).toBe(true);
    expect(rootErrors('~/work/a')).toBe(false);
    expect(rootErrors('/srv/a')).toBe(false);
  });

  it('account add --root refuses a relative path', async () => {
    const { env } = await converged();
    expect(await env.run('account', 'add', '--name', 'x', '--git-email', 'x@y.z', '--no-login', '--root', 'rel/x')).toBe(2);
  });
});

describe('CLI-4 / CLI-15: runner', () => {
  it('long runs (progress, interactive) have no default timeout; quick queries keep one', () => {
    expect(defaultTimeoutMs({})).toBeGreaterThan(0);
    expect(defaultTimeoutMs({ onLine: () => undefined })).toBeUndefined();
    expect(defaultTimeoutMs({ interactive: true })).toBeUndefined();
    expect(defaultTimeoutMs({ timeoutMs: 5 })).toBe(5);
  });

  it('a timeout kills the whole process group', async () => {
    const file = join((await makeEnv()).home, 'child.pid');
    const r = await new RealRunner({ PATH: process.env['PATH'] }).run('sh', ['-c', `sleep 30 & echo $! > ${file}; wait`], { timeoutMs: 1500 });
    expect(r.code).toBe(124);
    const pid = Number((await readFile(file, 'utf8')).trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a child killed by SIGINT is exit 130', async () => {
    const r = await new RealRunner({ PATH: process.env['PATH'] }).run('sh', ['-c', 'kill -INT $$']);
    expect(r.code).toBe(130);
  });

  it('a command that ended with 130 is a cancelled run', async () => {
    const out: string[] = [];
    const deps = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => out.push(s) }, stdoutIsTTY: false, env: {}, cancel: { cancelled: false } } as never;
    const code = await long(deps, { json: false, yes: true, verbose: false, configPath: '/c' } as never, async () => {
      throw new CommandError('rsync -aH a b', 130, '');
    });
    expect(code).toBe(ExitCode.Cancelled);
  });
});

describe('CLI-11 / CLI-12', () => {
  it('account remove asks unless --yes', async () => {
    const { env } = await converged();
    await env.run('account', 'add', '--name', 'business', '--git-email', 'a@work.example', '--no-login');
    expect(await env.run('account', 'remove', 'business')).toBe(3);
    expect(await readFile(configPath(env), 'utf8')).toContain('business');
    expect(await env.run('account', 'remove', 'business', '--yes')).toBe(0);
    expect(await readFile(configPath(env), 'utf8')).not.toMatch(/^\s*- name:\s*"?business/m);
  });

  it('--lines must be a positive integer', async () => {
    const { env } = await converged();
    for (const bad of ['abc', '0', '-3', '1.5']) {
      expect(await env.run('env', 'logs', 'whatever', '--lines', bad), bad).toBe(2);
      expect(await env.run('collector', 'logs', '--lines', bad), bad).toBe(2);
    }
  });

  it('--follow reads by bytes: multibyte text before the offset does not skip or repeat', async () => {
    const { readAppended } = await import('../src/commands-env.js');
    const f = join((await makeEnv()).home, 'log');
    await writeFile(f, 'árvíztűrő\n');
    const size = Buffer.byteLength('árvíztűrő\n');
    await writeFile(f, 'árvíztűrő\nnext\n');
    expect(await readAppended(f, size)).toEqual({ chunk: 'next\n', offset: size + 5 });
    expect((await readAppended(f, size + 5)).chunk).toBe('');
  });
});

void PassThrough;
