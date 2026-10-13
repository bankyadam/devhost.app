import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '@devhost/contract';
import type { ApplyData, Envelope } from '@devhost/contract';
import { fakeMac, makeEnv, ndjson } from './helpers.js';

const envelope = (text: string): Envelope => {
  const parsed = JSON.parse(text) as unknown;
  const r = validate<Envelope>('envelope', parsed);
  expect(r.ok, JSON.stringify(r.issues)).toBe(true);
  return parsed as Envelope;
};

async function initialized(...flags: string[]) {
  return initializedOn(fakeMac(), ...flags);
}

async function initializedOn({ runner, state }: ReturnType<typeof fakeMac>, ...flags: string[]) {
  const env = await makeEnv(runner);
  expect(await env.run('init', '--yes', '--hostname', 'macmini', ...flags)).toBe(0);
  env.out.length = 0;
  return { env, state, runner };
}

describe('--json contract', () => {
  it('version', async () => {
    const env = await makeEnv();
    expect(await env.run('version', '--json')).toBe(0);
    const e = envelope(env.stdout());
    expect(validate('result.version', e.data).ok).toBe(true);
    expect(e.data).toMatchObject({ contractVersion: 1 });
    expect(env.stdout()).not.toContain('\u001b['); // no ANSI codes
  });

  it('init, config get/set/validate', async () => {
    const env = await makeEnv();
    expect(await env.run('init', '--json', '--hostname', 'macmini')).toBe(0);
    expect(validate('result.init', envelope(env.stdout()).data).ok).toBe(true);
    env.out.length = 0;

    expect(await env.run('config', 'get', '/machine/hostname', '--json')).toBe(0);
    const got = envelope(env.stdout());
    expect(validate('result.config-get', got.data).ok).toBe(true);
    expect(got.data).toEqual({ pointer: '/machine/hostname', value: 'macmini' });
    env.out.length = 0;

    expect(await env.run('config', 'set', '/machine/hostname', 'newname', '--json')).toBe(0);
    expect(validate('result.config-set', envelope(env.stdout()).data).ok).toBe(true);
    env.out.length = 0;

    expect(await env.run('config', 'validate', '--json')).toBe(0);
    expect(validate('result.config-validate', envelope(env.stdout()).data).ok).toBe(true);
  });

  it('errors are envelopes with exit code 2 for config problems', async () => {
    const env = await makeEnv();
    expect(await env.run('config', 'validate', '--json')).toBe(2);
    const e = envelope(env.stdout());
    expect(e.ok).toBe(false);
    expect(e.errors[0]).toMatchObject({ code: 'config-invalid', hint: 'Run `devhost init` first.' });
  });

  it('unknown commands are usage errors (exit 2) in JSON too', async () => {
    const env = await makeEnv();
    expect(await env.run('bogus', '--json')).toBe(2);
    expect(envelope(env.stdout()).errors[0]?.code).toBe('usage');
  });

  it('apply --json streams valid events and ends with a result', async () => {
    const { env } = await initialized();
    expect(await env.run('apply', '--dry-run', '--json')).toBe(0);
    const events = ndjson(env.stdout());
    for (const e of events) expect(validate('events', e).ok, JSON.stringify(e)).toBe(true);
    const last = events[events.length - 1] as { type: string; ok: boolean; data: ApplyData };
    expect(last.type).toBe('result');
    expect(validate('result.apply', last.data).ok).toBe(true);
    expect(last.data.dryRun).toBe(true);
    expect(events.filter((e) => (e as { type: string }).type === 'step').length).toBeGreaterThan(6);
  });
});

describe('init', () => {
  it('writes a valid, private config with a generated ntfy topic', async () => {
    const env = await makeEnv();
    await env.run('init', '--yes', '--hostname', 'macmini', '--docker', 'orbstack', '--no-tailscale');
    const path = join(env.home, '.config', 'devhost', 'config.yaml');
    const text = await readFile(path, 'utf8');
    expect(text).toMatch(/topic: "devhost-[a-z0-9]{16}"/);
    expect(text).toContain('runtime: orbstack');
    expect(text).toContain('tailscale: false');
    expect(text).toContain('accounts: []');
    expect(await env.run('config', 'validate')).toBe(0);
    const { stat } = await import('node:fs/promises');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite without --force and keeps a backup with it', async () => {
    const env = await makeEnv();
    await env.run('init', '--yes');
    expect(await env.run('init', '--yes')).toBe(2);
    expect(await env.run('init', '--yes', '--hostname', 'other', '--force')).toBe(0);
    const files = await readdir(join(env.home, '.config', 'devhost'));
    expect(files.some((f) => f.startsWith('config.yaml.devhost-bak-20261012-203015'))).toBe(true);
  });

  it('rejects a bad hostname or docker runtime and writes nothing', async () => {
    const env = await makeEnv();
    expect(await env.run('init', '--yes', '--hostname', 'bad host')).toBe(2);
    expect(await env.run('init', '--yes', '--docker', 'podman')).toBe(2);
    await expect(readdir(join(env.home, '.config'))).rejects.toThrow();
  });
});

describe('config set', () => {
  it('does not write an invalid change', async () => {
    const { env } = await initialized();
    const path = join(env.home, '.config', 'devhost', 'config.yaml');
    const before = await readFile(path, 'utf8');
    expect(await env.run('config', 'set', '/docker/runtime', 'podman')).toBe(2);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(env.err.join('')).toContain('/docker/runtime');
  });

  it('keeps comments and backs up the previous file', async () => {
    const { env } = await initialized();
    expect(await env.run('config', 'set', '/collector/port', '4400')).toBe(0);
    const dir = join(env.home, '.config', 'devhost');
    expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toContain('# devhost configuration.');
    expect((await readdir(dir)).some((f) => f.includes('.devhost-bak-'))).toBe(true);
  });
});

describe('apply', () => {
  it('changes a fresh Mac, and a second apply changes nothing', async () => {
    const { env, state } = await initialized();
    expect(await env.run('apply')).toBe(0);
    expect(env.stdout()).toContain('Done: changes were applied.');
    expect(state.names.HostName).toBe('macmini');
    expect(state.power).toMatchObject({ sleep: 0, disksleep: 0, autorestart: 1, womp: 1 });
    expect(state.sshOn).toBe(true);
    expect(state.mise.get('node')).toBe('lts');
    const zshrc = await readFile(join(env.home, '.zshrc'), 'utf8');
    expect(zshrc).toContain('# >>> devhost >>>');

    env.out.length = 0;
    const callsBefore = env.runner.calls.length;
    expect(await env.run('apply', '--json')).toBe(0);
    const last = ndjson(env.stdout()).at(-1) as { data: ApplyData };
    expect(last.data.changed).toBe(false);
    expect(last.data.steps.every((s) => s.status === 'ok' || s.status === 'skipped')).toBe(true);
    expect(last.data.plan).toEqual([]);
    const mutating = env.runner.lines().slice(callsBefore).filter((l) => /^(sudo|brew bundle( |$)(?!check)|mise use)/.test(l) && !l.includes('bundle check'));
    expect(mutating).toEqual([]);
  });

  it('human output says there were no changes the second time', async () => {
    const { env } = await initialized();
    await env.run('apply');
    env.out.length = 0;
    await env.run('apply');
    expect(env.stdout()).toContain('No changes: the system already matches the config.');
  });

  it('on a laptop, leaves autorestart alone with a warning instead of failing', async () => {
    const { env, state } = await initializedOn(fakeMac({ laptop: true }));
    expect(await env.run('apply')).toBe(0);
    expect(env.err.join('')).toContain('this Mac does not support autorestart');
    expect(env.stdout()).toContain('Done: changes were applied.');
    expect(env.runner.lines()).toContain('sudo -n -- pmset -a sleep 0 disksleep 0 womp 1');
    expect(state.power['sleep']).toBe(0);
    env.out.length = 0;
    expect(await env.run('apply')).toBe(0);
    expect(env.stdout()).toContain('No changes: the system already matches the config.');
    env.out.length = 0;
    await env.run('doctor', '--json');
    const power = (JSON.parse(env.stdout()) as { data: { checks: { id: string; status: string; message: string }[] } }).data.checks.find((c) => c.id === 'system.power')!;
    expect(power.status).toBe('warn');
    expect(power.message).toContain('sleep 0, disksleep 0, womp 1');
  });

  it('updates a Claude Code too old for Remote Control; doctor flags it until then', async () => {
    const { env, state } = await initializedOn(fakeMac({ claudeVersion: '2.1.81' }));
    expect(await env.run('apply')).toBe(0);
    expect(env.runner.lines()).toContain('brew upgrade --cask claude-code');
    expect(state.claudeVersion).toBe('2.1.300');

    state.claudeVersion = '2.1.81';
    env.out.length = 0;
    await env.run('doctor', '--json');
    const claude = (JSON.parse(env.stdout()) as { data: { checks: { id: string; status: string; message: string; fix?: string }[] } }).data.checks.find((c) => c.id === 'tools.claude')!;
    expect(claude).toMatchObject({ status: 'fail', message: 'Claude Code 2.1.81 is too old for Remote Control (2.1.139 or newer)', fix: 'devhost apply --only claude.binary' });
  });

  it('says where it stopped when a step fails, not "No changes"', async () => {
    const { env } = await initializedOn(fakeMac({ pmsetIgnores: ['autorestart'] }));
    expect(await env.run('apply')).not.toBe(0);
    const out = env.stdout();
    expect(out).toContain('Stopped at system.power; the steps before it were applied, the steps after it did not run.');
    expect(out).not.toContain('No changes');
  });

  it('--dry-run mutates nothing and lists every sudo command', async () => {
    const { env, state } = await initialized();
    expect(await env.run('apply', '--dry-run')).toBe(0);
    const out = env.stdout();
    expect(out).toContain('Dry run plan');
    expect(out).toContain('[sudo] system.hostname: sudo scutil --set ComputerName macmini');
    expect(out).toContain('[sudo] system.power: sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1');
    expect(state.names.HostName).toBe('old');
    expect(state.sshOn).toBe(false);
    expect(env.runner.lines().filter((l) => l.startsWith('sudo') || l.startsWith('mise use'))).toEqual([]);
    await expect(readFile(join(env.home, '.zshrc'), 'utf8')).rejects.toThrow();
  });

  it('--only limits the steps', async () => {
    const { env } = await initialized();
    expect(await env.run('apply', '--dry-run', '--only', 'system.power', '--json')).toBe(0);
    const steps = ndjson(env.stdout()).filter((e) => (e as { type: string }).type === 'step' && (e as { status: string }).status !== 'start');
    expect(steps).toHaveLength(1);
    env.out.length = 0;
    expect(await env.run('apply', '--only', 'nope')).toBe(2);
  });

  it('stops at the first failing step with exit 1 and reports it', async () => {
    const failing = await makeEnv();
    await failing.run('init', '--yes');
    failing.deps.runner.run = async () => ({ code: 1, stdout: '', stderr: 'denied' });
    failing.out.length = 0;
    expect(await failing.run('apply', '--json')).toBe(1);
    const last = ndjson(failing.stdout()).at(-1) as { ok: boolean; data: ApplyData; errors: { code: string }[] };
    expect(last.ok).toBe(false);
    expect(last.data.steps.at(-1)?.status).toBe('failed');
    expect(last.errors[0]?.code).toBe('command-failed');
  });

  it('exits 3 when sudo needs a password and no terminal is attached', async () => {
    const { env, runner } = await initialized();
    runner.calls.length = 0;
    const original = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) =>
      cmd === 'sudo' ? { code: 1, stdout: '', stderr: 'sudo: a password is required\n' } : original(cmd, args, opts);
    expect(await env.run('apply')).toBe(3);
    expect(env.err.join('')).toContain('Terminal');
  });

  it('exits 130 when cancelled, leaving completed steps in place', async () => {
    const { env, state } = await initialized();
    const original = env.deps.runner.run.bind(env.deps.runner);
    env.deps.runner.run = async (cmd, args, opts) => {
      const r = await original(cmd, args, opts);
      if (args.includes('--set') && args.includes('ComputerName')) env.deps.cancel.cancelled = true;
      return r;
    };
    expect(await env.run('apply')).toBe(130);
    expect(env.stdout()).toContain('Cancelled after the current step');
    expect(state.sshOn).toBe(false);
  });

  it('a missing config is a usage error with a hint', async () => {
    const env = await makeEnv();
    expect(await env.run('apply')).toBe(2);
    expect(env.err.join('')).toContain('devhost init');
  });
});

describe('shell step preserves user content', () => {
  it('keeps existing ~/.zshrc lines and backs it up', async () => {
    const { env } = await initialized();
    await writeFile(join(env.home, '.zshrc'), 'export KEEP=1\n');
    await env.run('apply', '--only', 'shell');
    const text = await readFile(join(env.home, '.zshrc'), 'utf8');
    expect(text.startsWith('export KEEP=1\n')).toBe(true);
    expect((await readdir(env.home)).some((f) => f.startsWith('.zshrc.devhost-bak-'))).toBe(true);
  });
});

describe('init wizard', () => {
  it('asks for hostname, docker runtime and Tailscale when a terminal is attached', async () => {
    const { PassThrough } = await import('node:stream');
    const env = await makeEnv(undefined, true);
    const stdin = new PassThrough();
    env.deps.stdin = stdin;
    stdin.end('wizardmini\norbstack\nn\n');
    const code = await env.run('init');
    expect(code).toBe(0);
    const text = await readFile(join(env.home, '.config', 'devhost', 'config.yaml'), 'utf8');
    expect(text).toContain('hostname: wizardmini');
    expect(text).toContain('runtime: orbstack');
    expect(text).toContain('tailscale: false');
  });
});
