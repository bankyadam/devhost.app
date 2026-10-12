import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validate } from '@devhost/contract';
import type { ApplyData, DoctorData, Envelope, StatusData } from '@devhost/contract';
import { Db, dbPath } from '../src/collector/db.js';
import { fakeMac, makeEnv, ndjson, type TestEnv } from './helpers.js';

async function converged(opts: { tailscale?: boolean } = {}) {
  const mac = fakeMac();
  const env = await makeEnv(mac.runner);
  env.deps.env['DEVHOST_TRUST_IDLE_MS'] = '30';
  await env.run('init', '--yes', ...(opts.tailscale ? [] : ['--no-tailscale']));
  expect(await env.run('apply')).toBe(0);
  // The collector service would have created its database by now.
  const db = new Db(dbPath(env.home));
  db.run('INSERT INTO samples_system VALUES (?, 5, 30, 1, 2, 60, 10, 1)', env.deps.now().getTime());
  db.close();
  env.out.length = 0;
  env.err.length = 0;
  return { env, mac };
}

const doctor = async (env: TestEnv): Promise<{ code: number; data: DoctorData; envelope: Envelope }> => {
  env.out.length = 0;
  const code = await env.run('doctor', '--json');
  const envelope = JSON.parse(env.stdout()) as Envelope;
  return { code, data: envelope.data as DoctorData, envelope };
};

const problems = (d: DoctorData) => d.checks.filter((c) => c.status !== 'ok').map((c) => `${c.status}:${c.id}`);

describe('doctor', () => {
  it('after init + apply with zero accounts everything is green except "no accounts exist" (A16)', async () => {
    const { env } = await converged();
    const { code, data, envelope } = await doctor(env);
    expect(problems(data)).toEqual(['warn:accounts']);
    expect(code).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(validate('result.doctor', data).ok, JSON.stringify(validate('result.doctor', data).issues)).toBe(true);
    expect(data.summary.fail).toBe(0);
    expect(data.checks.find((c) => c.id === 'accounts')!.fix).toContain('devhost account add');
  });

  it('is green with two accounts and an environment once logged in and trusted', async () => {
    const { env, mac } = await converged();
    await env.run('account', 'add', '--name', 'personal', '--git-email', 'me@example.com', '--default', '--no-login');
    await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
    mac.state.loggedIn.add('default').add(join(env.home, '.claude-business'));
    env.deps.stdin = Object.assign(new PassThrough(), {});
    (env.deps.stdin as PassThrough).end(JSON.stringify({ id: 'trust-workspace', value: true }) + '\n' + JSON.stringify({ id: 'enable-remote-control', value: true }) + '\n');
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(0);
    await writeFile(join(env.home, '.claude-business', '.claude.json'), JSON.stringify({ projects: { [join(env.home, 'work', 'business', 'acme-api')]: { hasTrustDialogAccepted: true } } }));
    await env.run('apply');
    const { code, data } = await doctor(env);
    expect(problems(data)).toEqual(['warn:collector.data']); // no telemetry arrived in this test
    expect(code).toBe(0);
    for (const id of ['account.business.login', 'account.business.direnv', 'account.personal.direnv', 'env.acme-api.service', 'env.acme-api.git-identity', 'env.acme-api.trust']) {
      expect(data.checks.find((c) => c.id === id)?.status, id).toBe('ok');
    }
  });

  it('reports each problem with a fix and exits 1 on any failure', async () => {
    const { env, mac } = await converged();
    await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
    mac.state.power['sleep'] = 5;
    mac.state.sshOn = false;
    mac.state.colimaRunning = false;
    mac.state.loaded.delete('com.devhost.collector');
    const { code, data, envelope } = await doctor(env);
    expect(code).toBe(1);
    expect(envelope.ok).toBe(false);
    const byId = (id: string) => data.checks.find((c) => c.id === id)!;
    expect(byId('system.power')).toMatchObject({ status: 'fail', message: 'sleep should be 0', fix: 'devhost apply --only system.power' });
    expect(byId('system.ssh')).toMatchObject({ status: 'fail', fix: 'devhost apply --only system.ssh' });
    expect(byId('tools.docker')).toMatchObject({ status: 'fail' });
    expect(byId('collector.service')).toMatchObject({ status: 'fail', fix: 'devhost apply --only collector' });
    expect(byId('account.business.login')).toMatchObject({ status: 'fail', fix: 'devhost login business' });
    // Human output carries the same fixes.
    env.out.length = 0;
    expect(await env.run('doctor')).toBe(1);
    expect(env.stdout()).toContain('❌ system.power');
    expect(env.stdout()).toContain('fix: devhost login business');
    expect(env.stdout()).toMatch(/\d+ ok, \d+ warnings, \d+ failed/);
  });

  it('flags a missing config dir, a bad settings.json and a wrong CLAUDE_CONFIG_DIR', async () => {
    const { env, mac } = await converged();
    await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
    mac.state.loggedIn.add(join(env.home, '.claude-business'));
    await writeFile(join(env.home, 'work', 'business', '.envrc'), 'export CLAUDE_CONFIG_DIR=/wrong\n');
    await writeFile(join(env.home, '.claude-business', 'settings.json'), '{}');
    const { data } = await doctor(env);
    expect(data.checks.find((c) => c.id === 'account.business.settings')).toMatchObject({ status: 'fail', fix: 'devhost apply --only accounts.claude' });
    expect(data.checks.find((c) => c.id === 'account.business.direnv')).toMatchObject({ status: 'fail' });
    expect(data.checks.find((c) => c.id === 'account.business.direnv')!.message).toContain('/wrong');
  });

  it('warns about FileVault being off and about an OrbStack runtime', async () => {
    const mac = fakeMac({ fileVault: 'Off' });
    const env = await makeEnv(mac.runner);
    await env.run('init', '--yes', '--docker', 'orbstack', '--no-tailscale');
    await env.run('apply');
    const { data } = await doctor(env);
    expect(data.checks.find((c) => c.id === 'system.filevault')!.status).toBe('warn');
    expect(data.checks.find((c) => c.id === 'tools.docker-boot')!.status).toBe('warn');
  });

  it('a config problem is a usage error (exit 2), not a crash', async () => {
    const env = await makeEnv();
    expect(await env.run('doctor')).toBe(2);
  });
});

describe('status', () => {
  it('prints a one-screen summary and a contract-valid JSON', async () => {
    const { env, mac } = await converged();
    await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
    mac.state.loggedIn.add(join(env.home, '.claude-business'));
    env.out.length = 0;
    expect(await env.run('status')).toBe(0);
    expect(env.stdout()).toMatch(/Accounts:\s+business logged in/);
    expect(env.stdout()).toMatch(/Collector:\s+running, last sample \d+s ago/);
    expect(env.stdout().split('\n').length).toBeLessThanOrEqual(8);
    env.out.length = 0;
    expect(await env.run('status', '--json')).toBe(0);
    const e = JSON.parse(env.stdout()) as Envelope;
    expect(validate('result.status', e.data).ok, JSON.stringify(validate('result.status', e.data).issues)).toBe(true);
    expect((e.data as StatusData).docker).toBe('up');
  });
});

describe('uninstall', () => {
  async function full() {
    const s = await converged();
    const { env, mac } = s;
    await writeFile(join(env.home, '.zshrc'), 'export KEEP=1\n' + (await readFile(join(env.home, '.zshrc'), 'utf8')));
    await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
    mac.state.loggedIn.add(join(env.home, '.claude-business'));
    (env.deps as { stdin: unknown }).stdin = new PassThrough();
    const stdin = env.deps.stdin as PassThrough;
    stdin.end(JSON.stringify({ id: 'trust-workspace', value: true }) + '\n' + JSON.stringify({ id: 'enable-remote-control', value: true }) + '\n');
    await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json');
    await writeFile(join(env.home, '.claude-business', 'settings.json'), JSON.stringify({ ...JSON.parse(await readFile(join(env.home, '.claude-business', 'settings.json'), 'utf8')), theme: 'dark' }));
    await writeFile(join(env.home, '.claude-business', '.credentials.json'), '{"secret":true}');
    await mkdir(join(env.home, 'work', 'business', 'acme-api', 'src'), { recursive: true });
    await writeFile(join(env.home, 'work', 'business', 'acme-api', 'src', 'app.ts'), 'code');
    env.out.length = 0;
    env.err.length = 0;
    env.deps.stdin = new PassThrough();
    return s;
  }

  it('--dry-run lists every action including sudo and changes nothing', async () => {
    const { env, mac } = await full();
    expect(await env.run('uninstall', '--dry-run')).toBe(0);
    const out = env.stdout();
    expect(out).toContain('Dry run plan');
    expect(out).toContain('[sudo] uninstall.services: sudo launchctl bootout system/com.devhost.collector');
    expect(out).toContain('[sudo] uninstall.services: sudo rm -f');
    expect(out).toContain('uninstall.packages: brew uninstall --formula colima');
    expect(mac.state.loaded.size).toBeGreaterThan(0);
    expect(await readFile(join(env.home, '.zshrc'), 'utf8')).toContain('# >>> devhost >>>');
    expect(mac.state.uninstalled).toEqual([]);
  });

  it('removes services, blocks and generated files; keeps projects, Claude dirs, credentials, DB and config', async () => {
    const { env, mac } = await full();
    expect(await env.run('uninstall', '--yes', '--keep-packages', '--json')).toBe(0);
    const events = ndjson(env.stdout());
    for (const e of events) expect(validate('events', e).ok, JSON.stringify(e)).toBe(true);
    const last = events.at(-1) as { ok: boolean; data: ApplyData };
    expect(validate('result.apply', last.data).ok, JSON.stringify(validate('result.apply', last.data).issues)).toBe(true);
    expect(last.data.steps.find((s) => s.id === 'uninstall.packages')!.status).toBe('skipped');
    expect(last.data.kept?.join(' ')).toContain('credentials');

    expect(mac.state.loaded.size).toBe(0);
    expect(await readdir(join(env.home, 'LaunchDaemons'))).toEqual([]);
    expect(await readFile(join(env.home, '.zshrc'), 'utf8')).toBe('export KEEP=1\n');
    expect(await readFile(join(env.home, '.gitconfig'), 'utf8')).not.toContain('devhost');
    await expect(stat(join(env.home, '.config', 'devhost', 'Brewfile'))).rejects.toThrow();
    await expect(stat(join(env.home, '.config', 'devhost', 'git'))).rejects.toThrow();
    await expect(stat(join(env.home, 'work', 'business', 'acme-api', '.envrc'))).rejects.toThrow();
    expect(await readFile(join(env.home, '.claude-business', 'settings.json'), 'utf8')).toContain('"theme": "dark"');
    expect(await readFile(join(env.home, '.claude-business', 'settings.json'), 'utf8')).not.toContain('account=business');

    // Untouched.
    expect(await readFile(join(env.home, 'work', 'business', 'acme-api', 'src', 'app.ts'), 'utf8')).toBe('code');
    expect(await readFile(join(env.home, '.claude-business', '.credentials.json'), 'utf8')).toContain('secret');
    expect((await stat(dbPath(env.home))).isFile()).toBe(true);
    expect((await stat(join(env.home, '.config', 'devhost', 'config.yaml'))).isFile()).toBe(true);
    expect(mac.state.uninstalled).toEqual([]);

    // Running it again finds nothing.
    env.out.length = 0;
    expect(await env.run('uninstall', '--yes', '--keep-packages')).toBe(0);
    expect(env.stdout()).toContain('Nothing to remove.');
  });

  it('--purge-data deletes the database; packages are only removed after confirmation', async () => {
    const { env, mac } = await full();
    expect(await env.run('uninstall', '--yes', '--purge-data')).toBe(0);
    await expect(stat(dbPath(env.home))).rejects.toThrow();
    expect(mac.state.uninstalled.sort()).toEqual(['claude-code', 'colima', 'git', 'jq']); // only what is installed and in the Brewfile (this config has no Tailscale)
    expect(env.stdout()).not.toContain('add --purge-data');
  });

  it('declining the prompt changes nothing; without a terminal it needs --yes (exit 3)', async () => {
    const { env, mac } = await full();
    const stdin = new PassThrough();
    env.deps.stdin = stdin;
    stdin.end(JSON.stringify({ id: 'confirm-uninstall', value: false }) + '\n');
    expect(await env.run('uninstall', '--json')).toBe(1);
    expect(mac.state.loaded.size).toBeGreaterThan(0);
    env.out.length = 0;
    expect(await env.run('uninstall')).toBe(3);
    expect(mac.state.loaded.size).toBeGreaterThan(0);
  });
});

export type { TestEnv };
