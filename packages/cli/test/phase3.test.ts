import { appendFile, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { keychainService } from '../src/credentials.js';
import { validate } from '@devhost/contract';
import type { ApplyData, Envelope, UpdateData } from '@devhost/contract';
import { Db, dbPath } from '../src/collector/db.js';
import { fakeMac, makeEnv, ndjson, type TestEnv } from './helpers.js';

const j = (...objs: object[]): string => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

async function setup() {
  const mac = fakeMac();
  const env = await makeEnv(mac.runner);
  env.deps.env['DEVHOST_TRUST_IDLE_MS'] = '30';
  await env.run('init', '--yes', '--docker', 'none', '--no-tailscale');
  env.out.length = 0;
  return { env, mac };
}

function feed(env: TestEnv, ...answers: object[]): void {
  const stdin = new PassThrough();
  env.deps.stdin = stdin;
  stdin.end(j(...answers));
}

const cfg = (env: TestEnv) => readFile(join(env.home, '.config', 'devhost', 'config.yaml'), 'utf8');
const lastEnvelope = (env: TestEnv): Envelope => JSON.parse(env.stdout().trim().split('\n').at(-1)!) as Envelope;
const lastResult = (env: TestEnv) => ndjson(env.stdout()).at(-1) as { type: string; ok: boolean; data: Record<string, unknown>; errors?: { code: string; message: string }[] };

describe('account add / list / remove', () => {
  it('re-running add continues the setup when email and default match, and refuses otherwise', async () => {
    const { env } = await setup();
    const add = ['account', 'add', '--name', 'business', '--git-email', 'a@work.example', '--no-login'];
    expect(await env.run(...add)).toBe(0);
    env.out.length = 0;
    expect(await env.run(...add)).toBe(0);
    expect(env.stdout()).toContain('✅ Account "business" set up (port range 3000-3999');
    expect((await cfg(env)).match(/^\s+- name: business$/gm)).toHaveLength(1);

    env.out.length = 0;
    expect(await env.run('account', 'add', '--name', 'business', '--git-email', 'b@work.example', '--no-login', '--json')).toBe(2);
    expect(lastResult(env).errors?.[0]?.message).toBe('account "business" already exists with git email a@work.example');
    env.out.length = 0;
    expect(await env.run(...add, '--default', '--json')).toBe(2);
    expect(lastResult(env).errors?.[0]?.message).toBe('account "business" already exists as a non-default account');
  });

  it('installs direnv when the first account needs it before any apply installed packages', async () => {
    const mac = fakeMac();
    const env = await makeEnv(mac.runner);
    expect(await env.run('init', '--yes', '--no-tailscale')).toBe(0);
    expect(mac.state.binaries.has('direnv')).toBe(false);
    expect(await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login')).toBe(0);
    expect(mac.runner.lines()).toContain('brew install direnv');
    expect(mac.state.direnvAllowed.has(join(env.home, 'work', 'business'))).toBe(true);
    // A default account needs no direnv, so nothing is installed for it.
    const other = fakeMac();
    const env2 = await makeEnv(other.runner);
    await env2.run('init', '--yes', '--no-tailscale');
    expect(await env2.run('account', 'add', '--name', 'personal', '--git-email', 'me@example.com', '--default', '--no-login')).toBe(0);
    expect(other.runner.lines()).not.toContain('brew install direnv');
  });

  it('allocates port ranges, writes config and runs the account steps', async () => {
    const { env } = await setup();
    expect(await env.run('account', 'add', '--name', 'personal', '--git-email', 'me@example.com', '--git-name', 'Me', '--default', '--no-login')).toBe(0);
    env.out.length = 0;
    expect(await env.run('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--git-name', 'Me', '--daily-cost-alert', '50', '--no-login', '--json')).toBe(0);
    const result = lastResult(env);
    expect(validate('result.account-change', result.data).ok).toBe(true);
    expect(result.data).toMatchObject({ name: 'business', action: 'added', portRange: [4000, 4999], configDir: '~/.claude-business', root: '~/work/business' });

    const text = await cfg(env);
    expect(text).toContain('# devhost configuration.'); // comments survive
    expect(text).toMatch(/name: personal[\s\S]*configDir: null[\s\S]*portRange:[\s\S]*3000[\s\S]*name: business/);
    expect(text).toContain('dailyCostUsd: 50');
    expect(await readFile(join(env.home, '.claude-business', 'settings.json'), 'utf8')).toContain('account=business');
    expect(await readFile(join(env.home, 'work', 'business', '.envrc'), 'utf8')).toContain('CLAUDE_CONFIG_DIR');
    expect(await readFile(join(env.home, '.zshrc'), 'utf8')).toContain('alias claude-business=');

    // A third account gets the next block.
    env.out.length = 0;
    expect(await env.run('account', 'add', '--name', 'lab', '--git-email', 'l@x.y', '--no-login', '--json')).toBe(0);
    expect(lastResult(env).data).toMatchObject({ portRange: [5000, 5999] });
  });

  it('rejects duplicates, a second default, bad names and --force-default-switch', async () => {
    const { env } = await setup();
    await env.run('account', 'add', '--name', 'personal', '--git-email', 'a@b.c', '--default', '--no-login');
    expect(await env.run('account', 'add', '--name', 'personal', '--git-email', 'a@b.c', '--no-login')).toBe(2);
    expect(await env.run('account', 'add', '--name', 'second', '--git-email', 'a@b.c', '--default', '--no-login')).toBe(2);
    expect(env.err.join('')).toContain('already the default');
    expect(await env.run('account', 'add', '--name', 'Bad Name', '--git-email', 'a@b.c', '--no-login')).toBe(2);
    expect(await env.run('account', 'add', '--name', 'x', '--git-email', 'a@b.c', '--force-default-switch', '--no-login')).toBe(2);
    expect(env.err.join('')).toContain('not supported in v1');
    expect(await cfg(env)).not.toContain('name: second');
  });

  it('logs in through prompt events (URL out, code in)', async () => {
    const { env, mac } = await setup();
    feed(env, { id: 'auth-code', value: 'CODE-123' });
    expect(await env.run('account', 'add', '--name', 'business', '--git-email', 'a@b.c', '--json')).toBe(0);
    const events = ndjson(env.stdout());
    for (const e of events) expect(validate('events', e).ok, JSON.stringify(e)).toBe(true);
    const prompt = events.find((e) => (e as { type: string }).type === 'prompt') as { id: string; kind: string; url: string };
    expect(prompt).toMatchObject({ id: 'auth-code', kind: 'open-url' });
    expect(prompt.url).toBe('https://claude.ai/oauth/authorize?code=true&x=1');
    expect(mac.runner.spawned[0]!.process.written).toEqual(['CODE-123\n']);
    expect(mac.state.loggedIn.has(join(env.home, '.claude-business'))).toBe(true);
    expect(lastResult(env).data).toMatchObject({ loggedIn: true });
  });

  it('lists accounts with login state', async () => {
    const { env, mac } = await setup();
    await env.run('account', 'add', '--name', 'personal', '--git-email', 'a@b.c', '--default', '--no-login');
    await env.run('account', 'add', '--name', 'business', '--git-email', 'a@b.c', '--no-login');
    mac.state.loggedIn.add('default');
    env.out.length = 0;
    expect(await env.run('account', 'list', '--json')).toBe(0);
    const e = lastEnvelope(env);
    expect(validate('result.account-list', e.data).ok).toBe(true);
    const accounts = (e.data as { accounts: { name: string; loggedIn: boolean | null }[] }).accounts;
    expect(accounts.map((a) => [a.name, a.loggedIn])).toEqual([['personal', true], ['business', false]]);
  });
});

describe('environments', () => {
  async function withAccount() {
    const s = await setup();
    await s.env.run('account', 'add', '--name', 'business', '--git-email', 'a@work.example', '--no-login');
    s.mac.state.loggedIn.add(join(s.env.home, '.claude-business'));
    s.env.out.length = 0;
    s.env.err.length = 0;
    return s;
  }

  it('continues the setup when create is re-run after the sudo step stopped it (the app\'s "Open in Terminal")', async () => {
    const { env, mac } = await withAccount();
    const create = ['env', 'create', '--account', 'business', '--name', 'acme-api', '--repo', 'git@github.com:acme/api.git'];
    mac.state.sudoNeedsPassword = true;
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run(...create, '--permission-mode', 'plan', '--json')).toBe(3);
    expect(lastResult(env).errors?.[0]?.message).toContain('sudo needs a password');

    mac.state.sudoNeedsPassword = false;
    env.out.length = 0;
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    // The Terminal command repeats account, name and repo but not every wizard setting.
    expect(await env.run(...create, '--json')).toBe(0);
    const events = ndjson(env.stdout()) as { type: string; id?: string; status?: string }[];
    expect(events.find((e) => e.type === 'step' && e.id === 'config' && e.status !== 'start')).toMatchObject({ status: 'ok' });
    expect(lastResult(env).data).toMatchObject({ name: 'acme-api', portBase: 3000 });
    const text = await cfg(env);
    expect(text.match(/^\s+- name: acme-api$/gm)).toHaveLength(1);
    const plist = await readFile(join(env.home, 'LaunchDaemons', 'com.devhost.rc.business.acme-api.plist'), 'utf8');
    expect(plist).toContain('<string>plan</string>'); // the config's settings win
  });

  it('a Claude Code too old for Remote Control stops trust with the fix, not a silent success', async () => {
    const { env, mac } = await withAccount();
    mac.state.claudeVersion = '2.1.81';
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(3);
    const err = lastResult(env).errors?.[0] as { message: string; hint?: string };
    expect(err.message).toContain('too old for Remote Control (2.1.139 or newer is needed)');
    expect(err.hint).toContain('devhost apply --only claude.binary');
  });

  it('in a terminal, trust is reported from what Claude Code recorded, not assumed', async () => {
    const mac = fakeMac();
    const env = await makeEnv(mac.runner, true);
    await env.run('init', '--yes', '--docker', 'none', '--no-tailscale');
    await env.run('account', 'add', '--name', 'business', '--git-email', 'a@work.example', '--no-login');
    mac.state.loggedIn.add(join(env.home, '.claude-business'));
    env.out.length = 0;
    // Claude Code ran on the terminal but stopped before asking: nothing recorded.
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api')).toBe(0);
    expect(env.stdout()).toMatch(/trust\.acme-api — not trusted \(declined, or Claude Code stopped before asking\)/);

    // Answered in the terminal: Claude Code wrote the trust into its state file.
    const dir = join(env.home, 'work', 'business', 'other');
    await writeFile(join(env.home, '.claude-business', '.claude.json'), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    env.out.length = 0;
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'other')).toBe(0);
    expect(env.stdout()).toMatch(/✅ trust\.other/);
  });

  it('skips Claude Code when the workspace is already trusted (the running service would refuse it)', async () => {
    const { env, mac } = await withAccount();
    const dir = join(env.home, 'work', 'business', 'acme-api');
    await mkdir(join(env.home, '.claude-business'), { recursive: true });
    await writeFile(join(env.home, '.claude-business', '.claude.json'), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(0);
    expect(mac.runner.spawned.filter((s) => s.call.args.some((a) => a.endsWith('pty-run.py')))).toEqual([]);
    const trust = (ndjson(env.stdout()) as { type: string; id?: string; status?: string }[]).filter((e) => e.type === 'step' && e.id === 'trust.acme-api');
    expect(trust.at(-1)).toMatchObject({ status: 'ok' });
  });

  it('trust that Claude Code did not record is not reported as done (the pty ran, nothing was written)', async () => {
    const { env, mac } = await withAccount();
    mac.state.claudeForgetsTrust = true;
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(0);
    const trust = (ndjson(env.stdout()) as { type: string; id?: string; status?: string; message?: string }[]).filter((e) => e.type === 'step' && e.id === 'trust.acme-api');
    expect(trust.at(-1)).toMatchObject({ status: 'skipped', message: expect.stringContaining('not trusted') });
  });

  it('answers the trust question no sooner than Claude Code accepts one (it ignores answers that come too quickly)', async () => {
    const { env } = await withAccount();
    env.deps.env['DEVHOST_TRUST_ANSWER_MS'] = '350';
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    const t0 = Date.now();
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2 * 350 - 50); // the trust question and the Remote Control one
  });

  it('refuses to re-run create with a different account or repo', async () => {
    const { env } = await withAccount();
    await env.run('account', 'add', '--name', 'lab', '--git-email', 'l@x.y', '--no-login');
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--repo', 'git@github.com:acme/api.git', '--json')).toBe(0);
    env.out.length = 0;
    expect(await env.run('env', 'create', '--account', 'lab', '--name', 'acme-api', '--json')).toBe(2);
    expect(lastResult(env).errors?.[0]?.message).toBe('environment "acme-api" already exists with account business');
    env.out.length = 0;
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--repo', 'git@github.com:acme/other.git', '--json')).toBe(2);
    expect(lastResult(env).errors?.[0]?.message).toBe('environment "acme-api" already exists with repo git@github.com:acme/api.git');
    expect((await cfg(env)).match(/^\s+- name: acme-api$/gm)).toHaveLength(1);
  });

  it('refuses to create an environment for a missing account', async () => {
    const { env } = await setup();
    expect(await env.run('env', 'create', '--account', 'ghost', '--name', 'x')).toBe(2);
    expect(env.err.join('')).toContain('devhost account add --name ghost');
  });

  it('creates an environment: repo, port block, .envrc, trust prompts, boot-time service', async () => {
    const { env, mac } = await withAccount();
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--repo', 'git@github.com:acme/api.git', '--json')).toBe(0);

    const events = ndjson(env.stdout());
    for (const e of events) expect(validate('events', e).ok, JSON.stringify(e)).toBe(true);
    const prompts = events.filter((e) => (e as { type: string }).type === 'prompt') as { id: string; kind: string }[];
    expect(prompts.map((p) => [p.id, p.kind])).toEqual([['trust-workspace', 'confirm'], ['enable-remote-control', 'confirm']]);
    const result = lastResult(env);
    expect(validate('result.env-change', result.data).ok).toBe(true);
    expect(result.data).toMatchObject({ name: 'acme-api', action: 'created', portBase: 3000 });

    const dir = join(env.home, 'work', 'business', 'acme-api');
    const envrc = await readFile(join(dir, '.envrc'), 'utf8');
    expect(envrc).toContain('export DEVHOST_PORT_BASE=3000');
    expect(envrc).toContain('OTEL_RESOURCE_ATTRIBUTES="devhost.account=business,devhost.env=acme-api"');
    expect(await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.envrc');
    expect(mac.runner.lines()).toContain(`git clone -- git@github.com:acme/api.git ${dir}`);

    // Trust ran through a pty with the right answers, and the server was stopped with Ctrl+C.
    const trust = mac.runner.spawned.find((s) => s.call.args.some((a) => a.endsWith('pty-run.py')))!;
    expect(trust.call.command).toBe('/usr/bin/python3');
    expect(trust.call.args.join(' ')).toContain('remote-control --name business-acme-api --spawn same-dir --no-create-session-in-dir');
    expect(trust.process.written).toEqual(['y\n', 'y\n', '\u0003']);

    // The service: LaunchDaemon with the operator as UserName, running at boot.
    const plist = await readFile(join(env.home, 'LaunchDaemons', 'com.devhost.rc.business.acme-api.plist'), 'utf8');
    expect(plist).toContain('<string>tester</string>');
    expect(plist).toContain(`<string>${dir}</string>`);
    for (const s of ['remote-control', '--name', 'business-acme-api', '--spawn', 'worktree', '--permission-mode', 'acceptEdits']) expect(plist).toContain(`<string>${s}</string>`);
    expect(plist).toContain('<key>CLAUDE_CONFIG_DIR</key>');
    expect(plist).toContain('<key>DEVHOST_PORT_BASE</key>\n    <string>3000</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('rc-business-acme-api.log');
    expect(mac.state.loaded.has('com.devhost.rc.business.acme-api')).toBe(true);
    expect(mac.runner.lines()).toContain('sudo -n -- launchctl bootstrap system ' + join(env.home, 'LaunchDaemons', 'com.devhost.rc.business.acme-api.plist'));

    // Persisted port block; second env gets the next one.
    expect(await cfg(env)).toContain('portBase: 3000');
    env.out.length = 0;
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'second', '--json')).toBe(0);
    expect(lastResult(env).data).toMatchObject({ portBase: 3100 });
  });

  it('a declined trust prompt leaves the config and warns', async () => {
    const { env, mac } = await withAccount();
    feed(env, { id: 'trust-workspace', value: false });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'x', '--json')).toBe(0);
    expect(mac.runner.spawned[0]!.process.written).toEqual(['n\n']);
    expect(ndjson(env.stdout()).some((e) => (e as { id?: string; status?: string }).id === 'trust.x' && (e as { status: string }).status === 'skipped')).toBe(true);
  });

  it('--no-rc creates no service; env list shows it as disabled', async () => {
    const { env, mac } = await withAccount();
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'plain', '--no-rc')).toBe(0);
    expect(mac.state.loaded.size).toBe(0);
    env.out.length = 0;
    expect(await env.run('env', 'list', '--json')).toBe(0);
    const e = lastEnvelope(env);
    expect(validate('result.env-list', e.data).ok).toBe(true);
    expect((e.data as { environments: { service: { state: string } }[] }).environments[0]!.service.state).toBe('disabled');
  });

  async function created() {
    const s = await withAccount();
    feed(s.env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    await s.env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json');
    s.env.out.length = 0;
    s.env.err.length = 0;
    s.env.deps.stdin = new PassThrough();
    return { ...s, dir: join(s.env.home, 'work', 'business', 'acme-api') };
  }

  it('env list/stop/start/restart drive launchd with sudo', async () => {
    const { env, mac } = await created();
    expect(await env.run('env', 'list', '--json')).toBe(0);
    expect((lastEnvelope(env).data as { environments: { service: { state: string; pid: number } }[] }).environments[0]!.service).toMatchObject({ state: 'running', pid: 4242 });

    const label = 'com.devhost.rc.business.acme-api';
    expect(await env.run('env', 'stop', 'acme-api')).toBe(0);
    expect(mac.runner.lines()).toContain(`sudo -n -- launchctl bootout system/${label}`);
    expect(mac.state.loaded.has(label)).toBe(false);
    expect(await env.run('env', 'start', 'acme-api')).toBe(0);
    expect(mac.state.loaded.has(label)).toBe(true);
    expect(await env.run('env', 'restart', 'acme-api')).toBe(0);
    expect(mac.runner.lines()).toContain(`sudo -n -- launchctl kickstart -k system/${label}`);
  });

  it('session reattach brings an ended worktree session back as a one-shot service, and clears ended ones', async () => {
    const { env, mac, dir } = await created();
    const wt = join(dir, '.claude', 'worktrees', 'bridge-cse_01Abc');
    await mkdir(wt, { recursive: true });
    const now = env.deps.now().getTime();
    const db = new Db(dbPath(env.home));
    db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at) VALUES ('6a7802e0-1111', 'business', 'acme-api', ?, 'ended', ?, ?, ?)", join(wt, 'sub'), now - 60_000, now - 30_000, now - 1000);
    db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at) VALUES ('7b000000-2222', 'business', 'acme-api', ?, 'idle', ?, ?, NULL)", wt, now - 60_000, now - 30_000);
    db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at, remote_session) VALUES ('8c000000-3333', 'business', 'acme-api', ?, 'ended', ?, ?, ?, 'session_01Own')", dir, now - 60_000, now - 30_000, now - 1000);
    db.close();
    const log = join(env.home, 'Library', 'Logs', 'devhost', 'rc-business-acme-api-cse_01Abc.log');
    await mkdir(dirname(log), { recursive: true });
    await writeFile(log, 'Connected · an earlier run\n'); // only this run's output counts
    // An earlier reattach that has ended (installed, not loaded).
    const old = join(env.home, 'LaunchDaemons', 'com.devhost.reattach.cse_0ld.plist');
    await writeFile(old, '<plist/>');
    let started = 0;
    mac.state.onBootstrap = (label) => {
      if (label !== 'com.devhost.reattach.cse_01Abc') return;
      started++;
      void appendFile(log, '·✔︎· Connected · bridge-cse_01Abc\n');
    };

    expect(await env.run('session', 'reattach', '7b000000')).toBe(2); // still idle
    expect(await env.run('session', 'reattach', '8c000000')).toBe(2); // not a Remote Control worktree (the environment folder is the service's)
    env.out.length = 0;
    expect(await env.run('session', 'reattach', '6a7802e0', '--json')).toBe(0);
    const data = lastResult(env).data;
    expect(validate('result.session-reattach', data).ok).toBe(true);
    expect(data).toMatchObject({ session: '6a7802e0-1111', remoteSession: 'session_01Abc', url: 'https://claude.ai/code/session_01Abc', label: 'com.devhost.reattach.cse_01Abc', logPath: log, removed: ['com.devhost.reattach.cse_0ld'] });
    expect(started).toBe(1);
    const plist = await readFile(join(env.home, 'LaunchDaemons', 'com.devhost.reattach.cse_01Abc.plist'), 'utf8');
    expect(plist).toContain(`<string>${wt}</string>`);
    expect(plist).toContain('<string>--session-id</string>\n    <string>session_01Abc</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\n\s*<false\/>/);
    expect(plist).toContain('<string>/Users/test/.claude-business</string>'.replace('/Users/test', env.home));
    await expect(stat(old)).rejects.toThrow();

    // Running already: refused. The dashboard knows which sessions can be reattached.
    expect(await env.run('session', 'reattach', '6a7802e0')).toBe(2);
    env.out.length = 0;
    await env.run('dash', '--json');
    const sessions = (lastEnvelope(env).data as { sessions: { id: string; remoteSession: string | null }[] }).sessions;
    expect(Object.fromEntries(sessions.map((x) => [x.id, x.remoteSession]))).toEqual({ '6a7802e0-1111': 'session_01Abc', '7b000000-2222': 'session_01Abc', '8c000000-3333': null });
  });

  it('a Remote Control service renews its bridge pointer before it starts, and drops one it could not start with', async () => {
    const { env, dir } = await created();
    const service = await readFile(join(env.home, 'LaunchDaemons', 'com.devhost.rc.business.acme-api.plist'), 'utf8');
    const pointer = `${env.home}/.claude-business/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/bridge-pointer.json`;
    const seen = `${env.home}/.local/share/devhost/rc/com.devhost.rc.business.acme-api.pointer`;
    expect(service).toContain(`if [ -f ${pointer} ]; then if /usr/bin/cmp -s ${pointer} ${seen}; then`);
  });

  it('update --check names a newer Claude Code and the outdated Brewfile packages, and changes nothing', async () => {
    const { env, mac } = await created();
    mac.state.binaries.add('claude');
    mac.state.claudeLatest = '2.1.310';
    mac.state.outdated = { formulae: [{ name: 'git', installed_versions: ['2.50.0'], current_version: '2.51.0' }, { name: 'ffmpeg', installed_versions: ['7.0'], current_version: '7.1' }], casks: [{ name: 'claude-code', installed_versions: '2.1.300', current_version: '2.1.310' }] };
    expect(await env.run('update', '--check', '--json')).toBe(0);
    const data = lastResult(env).data as unknown as UpdateData;
    expect(validate('result.update', data).ok).toBe(true);
    expect(data.claude).toMatchObject({ install: 'brew', installed: '2.1.300', latest: '2.1.310', outdated: true });
    expect(data.packages).toEqual([{ name: 'git', installed: '2.50.0', latest: '2.51.0', cask: false }]); // ffmpeg is not in the Brewfile
    expect(mac.runner.lines().filter((l) => /brew upgrade|kickstart/.test(l))).toEqual([]);
  });

  it('update waits while a session is in the middle of a turn', async () => {
    const { env, mac, dir } = await created();
    mac.state.binaries.add('claude');
    mac.state.claudeLatest = '2.1.310';
    const now = env.deps.now().getTime();
    const db = new Db(dbPath(env.home));
    db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at) VALUES ('5e000000-1111', 'business', 'acme-api', ?, 'running', ?, ?, NULL)", dir, now - 60_000, now - 30_000);
    db.close();
    expect(await env.run('update', '--json')).toBe(0);
    const data = lastResult(env).data as unknown as UpdateData;
    expect(data.busy).toEqual(['business/acme-api · 5e000000']);
    expect(data.claude.updated).toBeUndefined();
    expect(mac.runner.lines().filter((l) => /brew upgrade|kickstart/.test(l))).toEqual([]);
  });

  it('update upgrades Claude Code, restarts the services onto it, removes reattach jobs and lists the detached sessions', async () => {
    const { env, mac, dir } = await created();
    mac.state.binaries.add('claude');
    mac.state.claudeLatest = '2.1.310';
    await mkdir(join(dir, '.claude', 'worktrees', 'bridge-cse_01Live'), { recursive: true });
    await mkdir(join(dir, '.claude', 'worktrees', 'bridge-cse_02Old'), { recursive: true });
    mac.state.procs = [
      ' 4242 1 1.0 1000 /opt/homebrew/bin/claude remote-control --name business-acme-api',
      ' 4300 4242 1.0 1000 /opt/homebrew/Caskroom/claude-code/2.1.300/claude --print --sdk-url https://api.anthropic.com/v1/code/sessions/cse_01Live --session-id cse_01Live',
    ];
    // A reattach job from earlier: it registers its own single-session environment, which hides acme-api on claude.ai.
    const job = join(env.home, 'LaunchDaemons', 'com.devhost.reattach.cse_02Old.plist');
    await writeFile(job, '<plist/>');
    mac.state.loaded.add('com.devhost.reattach.cse_02Old');

    expect(await env.run('update', '--json')).toBe(0);
    const data = lastResult(env).data as unknown as UpdateData;
    expect(validate('result.update', data).ok).toBe(true);
    expect(data.claude).toMatchObject({ installed: '2.1.310', outdated: false, updated: true });
    expect(data.restarted).toEqual(['com.devhost.rc.business.acme-api']);
    expect(data.removed).toEqual(['com.devhost.reattach.cse_02Old']);
    expect(data.detached).toEqual([
      { remoteSession: 'session_01Live', account: 'business', env: 'acme-api', url: 'https://claude.ai/code/session_01Live' },
      { remoteSession: 'session_02Old', account: 'business', env: 'acme-api', url: 'https://claude.ai/code/session_02Old' },
    ]);
    const lines = mac.runner.lines();
    const upgrade = lines.indexOf('brew upgrade --cask claude-code');
    const restart = lines.indexOf('sudo -n -- launchctl kickstart -k system/com.devhost.rc.business.acme-api');
    expect(upgrade).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(upgrade);
    expect(mac.state.loaded.has('com.devhost.reattach.cse_02Old')).toBe(false);
    await expect(stat(job)).rejects.toThrow();
    expect(lines.some((l) => l.includes('reattach.cse_01Live'))).toBe(false); // nothing is reattached

    // Current now: nothing more to do.
    mac.runner.calls.length = 0;
    expect(await env.run('update', '--json')).toBe(0);
    expect(mac.runner.lines().filter((l) => /brew upgrade|kickstart/.test(l))).toEqual([]);
  });

  it('update --all also upgrades the outdated Brewfile packages', async () => {
    const { env, mac } = await created();
    mac.state.binaries.add('claude');
    mac.state.outdated = { formulae: [{ name: 'git', installed_versions: ['2.50.0'], current_version: '2.51.0' }], casks: [] };
    expect(await env.run('update', '--all', '--json')).toBe(0);
    expect(mac.state.upgraded).toEqual(['git']);
    expect((lastResult(env).data as unknown as UpdateData).packages).toEqual([{ name: 'git', installed: '2.50.0', latest: '2.51.0', cask: false, updated: true }]);
  });

  it('session reattach that cannot connect (the session is gone on claude.ai) fails and leaves no job behind', async () => {
    const { env, mac, dir } = await created();
    const wt = join(dir, '.claude', 'worktrees', 'bridge-cse_02Gone');
    await mkdir(wt, { recursive: true });
    const now = env.deps.now().getTime();
    const db = new Db(dbPath(env.home));
    db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at) VALUES ('9d000000-4444', 'business', 'acme-api', ?, 'ended', ?, ?, ?)", wt, now - 60_000, now - 30_000, now - 1000);
    db.close();
    const log = join(env.home, 'Library', 'Logs', 'devhost', 'rc-business-acme-api-cse_02Gone.log');
    await mkdir(dirname(log), { recursive: true });
    mac.state.onBootstrap = (label) => {
      if (label !== 'com.devhost.reattach.cse_02Gone') return;
      void appendFile(log, 'Error: Session session_02Gone not found. It may have been archived or expired.\n');
      mac.state.loaded.delete(label); // it exits
    };
    env.out.length = 0;
    expect(await env.run('session', 'reattach', '9d000000', '--json')).toBe(1);
    expect(lastResult(env).errors![0]!.message).toContain('Session session_02Gone not found');
    await expect(stat(join(env.home, 'LaunchDaemons', 'com.devhost.reattach.cse_02Gone.plist'))).rejects.toThrow();
  });

  it('an empty repository gets an empty first commit for worktree sessions; without Remote Control it is left alone; doctor reports one without', async () => {
    const s = await withAccount();
    const { env, mac } = s;
    mac.state.emptyRemotes = new Set(['git@gitlab.com:acme/new.git']);
    feed(env, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'fresh', '--repo', 'git@gitlab.com:acme/new.git', '--json')).toBe(0);
    const dir = join(env.home, 'work', 'business', 'fresh');
    expect(mac.runner.lines()).toContain(`git -C ${dir} commit --allow-empty --quiet -m Initial commit`);
    expect(mac.runner.lines().some((l) => /git .*push/.test(l))).toBe(false); // local only

    mac.runner.calls.length = 0;
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'plain', '--no-rc')).toBe(0);
    expect(mac.runner.lines().some((l) => l.includes('commit --allow-empty'))).toBe(false);

    mac.state.commits!.delete(dir);
    env.out.length = 0;
    await env.run('doctor', '--json');
    expect((lastEnvelope(env).data as { checks: { id: string; status: string }[] }).checks.find((c) => c.id === 'env.fresh.head')).toMatchObject({ status: 'fail' });
    expect(await env.run('apply', '--only', 'env.fresh')).toBe(0);
    expect(mac.state.commits!.has(dir)).toBe(true);
  });

  it('a second apply after creation changes nothing', async () => {
    const { env } = await created();
    expect(await env.run('apply')).toBe(0); // converge the machine-level steps first
    env.out.length = 0;
    expect(await env.run('apply', '--json')).toBe(0);
    const data = lastResult(env).data as unknown as ApplyData;
    expect(data.steps.filter((s) => s.status === 'changed')).toEqual([]);
  });

  it('apply allocates a missing portBase and persists it', async () => {
    const { env } = await withAccount();
    const path = join(env.home, '.config', 'devhost', 'config.yaml');
    await writeFile(path, (await cfg(env)).replace('environments: []', 'environments:\n  - { name: hand, account: business, remoteControl: { enabled: false } }'));
    expect(await env.run('apply', '--dry-run', '--only', 'env.hand')).toBe(0);
    expect(env.stdout()).toContain('set environments/hand/portBase to 3000');
    expect(await cfg(env)).not.toMatch(/^ *portBase:/m);
    expect(await env.run('apply', '--only', 'env.hand')).toBe(0);
    expect(await cfg(env)).toContain('portBase: 3000');
    expect((await stat(join(env.home, 'work', 'business', 'hand', '.git'))).isDirectory()).toBe(true);
  });

  it('delete: keeps files by default, asks for the typed name with --delete-files', async () => {
    const { env, mac, dir } = await created();
    mac.state.unpushed.set(dir, 'abc1234 wip: not pushed\n');

    expect(await env.run('env', 'delete', 'acme-api', '--delete-files', '--confirm-name', 'wrong')).toBe(2);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await cfg(env)).toMatch(/^ *- name: acme-api/m);

    // Typed name through a prompt event.
    env.out.length = 0;
    feed(env, { id: 'confirm-name', value: 'acme-api' });
    expect(await env.run('env', 'delete', 'acme-api', '--delete-files', '--json')).toBe(0);
    const events = ndjson(env.stdout());
    expect(events.some((e) => (e as { type: string; id?: string; kind?: string }).type === 'prompt' && (e as { id: string }).id === 'confirm-name')).toBe(true);
    expect(events.some((e) => (e as { type: string; message?: string }).type === 'log' && String((e as { message: string }).message).includes('abc1234 wip: not pushed'))).toBe(true);
    const data = lastResult(env).data;
    expect(validate('result.env-change', data).ok).toBe(true);
    expect(data).toMatchObject({ action: 'deleted', filesDeleted: true, unpushed: { commits: ['abc1234 wip: not pushed'] } });
    await expect(stat(dir)).rejects.toThrow();
    expect(await cfg(env)).not.toMatch(/^ *- name: acme-api/m);
    expect(mac.state.loaded.size).toBe(0);
    expect(await readdir(join(env.home, 'LaunchDaemons'))).toEqual([]);
  });

  it('a setup that failed at compose (a network left from before) says how to fix it and continues when run again', async () => {
    const { env, mac } = await withAccount();
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc')).toBe(0);
    const dir = join(env.home, 'work', 'business', 'acme-api');
    await writeFile(join(dir, 'compose.yaml'), 'services: { db: { image: postgres } }\n');
    const original = mac.runner.run.bind(mac.runner);
    let networkLeft = true;
    mac.runner.run = async (cmd, args, opts) =>
      networkLeft && cmd === 'docker' && args.includes('up')
        ? { code: 1, stdout: '', stderr: 'network devhost-acme-api_default was found but has incorrect label com.docker.compose.network set to ""\n' }
        : original(cmd, args, opts);
    env.out.length = 0;
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(1);
    const failed = lastResult(env).errors?.[0] as { code: string; message: string; hint?: string };
    expect(failed.code).toBe('compose-network-exists');
    expect(failed.message).toContain('could not create the network "devhost-acme-api_default"');
    expect(failed.hint).toContain('docker network rm devhost-acme-api_default');
    expect(failed.hint).toContain('Run setup again');
    // Fixed by hand; the same command continues instead of saying the environment exists.
    networkLeft = false;
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api')).toBe(0);
    expect(mac.state.composeUp.has('devhost-acme-api')).toBe(true);
    expect((await cfg(env)).match(/^\s+- name: acme-api$/gm)).toHaveLength(1);
  });

  it('agents: apply writes the configured agent files per account and environment, leaves the user\'s own, removes dropped ones', async () => {
    const { env, dir } = await created();
    const path = join(env.home, '.config', 'devhost', 'config.yaml');
    const base = await readFile(path, 'utf8');
    const acct = join(env.home, '.claude-business', 'agents');
    const envAgents = join(dir, '.claude', 'agents');
    await mkdir(acct, { recursive: true });
    await writeFile(join(acct, 'explorer.md'), 'my own explorer\n');
    await writeFile(path, `${base}\nagents:\n  custom:\n    - { name: sql-helper, description: Writes SQL, prompt: Write SQL. }\n`.replace(/\n(accounts:)/, '\n$1'));
    // agents: on the account and the environment (edited in place)
    let text = (await readFile(path, 'utf8')).replace(/(- name: business\n)/, '$1    agents: [explorer, reviewer]\n').replace(/(- name: acme-api\n)/, '$1    agents: [test-runner, sql-helper]\n');
    await writeFile(path, text);
    expect(await env.run('apply', '--only', 'agents')).toBe(0);
    expect(await readFile(join(acct, 'explorer.md'), 'utf8')).toBe('my own explorer\n'); // not devhost's: untouched
    expect(await readFile(join(acct, 'reviewer.md'), 'utf8')).toContain('managed by devhost');
    expect(await readFile(join(envAgents, 'sql-helper.md'), 'utf8')).toContain('description: "Writes SQL"');
    expect(await readFile(join(envAgents, 'test-runner.md'), 'utf8')).toContain('model: haiku');
    // Dropping an agent removes only its managed file; a second apply changes nothing.
    text = text.replace('[test-runner, sql-helper]', '[sql-helper]');
    await writeFile(path, text);
    expect(await env.run('apply', '--only', 'agents')).toBe(0);
    await expect(stat(join(envAgents, 'test-runner.md'))).rejects.toThrow();
    expect(await readFile(join(envAgents, 'sql-helper.md'), 'utf8')).toContain('Write SQL.');
    // An unknown name is a config error.
    await writeFile(path, text.replace('[sql-helper]', '[nope]'));
    expect(await env.run('apply', '--only', 'agents')).not.toBe(0);
  });

  it('agents list shows the catalog, custom agents and what each account and environment has', async () => {
    const { env, dir } = await created();
    const path = join(env.home, '.config', 'devhost', 'config.yaml');
    await writeFile(path, `${await readFile(path, 'utf8')}\nagents:\n  custom:\n    - { name: sql-helper, description: Writes SQL, prompt: Write SQL., model: sonnet }\n`);
    expect(await env.run('config', 'set', '/environments/0/agents', '["explorer","sql-helper"]')).toBe(0);
    env.out.length = 0;
    expect(await env.run('agents', 'list', '--json')).toBe(0);
    const data = lastResult(env).data as { delegation: boolean; agents: { name: string; builtin: boolean; model: string | null }[]; targets: { scope: string; account: string; env: string | null; dir: string; agents: string[] }[] };
    expect(validate('result.agents-list', data).ok).toBe(true);
    expect(data.delegation).toBe(false);
    expect(data.agents.map((a) => [a.name, a.builtin])).toEqual([['explorer', true], ['reviewer', true], ['test-runner', true], ['docs', true], ['sql-helper', false]]);
    expect(data.agents.find((a) => a.name === 'sql-helper')?.model).toBe('sonnet');
    expect(data.targets).toEqual([
      { scope: 'account', account: 'business', env: null, dir: join(env.home, '.claude-business', 'agents'), agents: [] },
      { scope: 'environment', account: 'business', env: 'acme-api', dir: join(dir, '.claude', 'agents'), agents: ['explorer', 'sql-helper'] },
    ]);
  });

  it('agents.delegation adds the subagent rule to the account CLAUDE.md, and removes it again', async () => {
    const { env } = await created();
    const path = join(env.home, '.config', 'devhost', 'config.yaml');
    const claudeMd = join(env.home, '.claude-business', 'CLAUDE.md');
    expect(await readFile(claudeMd, 'utf8')).not.toContain('## Subagents');
    const base = await readFile(path, 'utf8');
    await writeFile(path, `${base}\nagents: { delegation: true }\n`);
    expect(await env.run('apply', '--only', 'accounts.claude')).toBe(0);
    expect(await readFile(claudeMd, 'utf8')).toContain('## Subagents');
    expect(await readFile(claudeMd, 'utf8')).toContain('Start independent subtasks in parallel');
    await writeFile(path, base);
    expect(await env.run('apply', '--only', 'accounts.claude')).toBe(0);
    expect(await readFile(claudeMd, 'utf8')).not.toContain('## Subagents');
  });

  it('a compose project that does not come up still gets its Remote Control service, so a session can fix it', async () => {
    const { env, mac, dir } = await created();
    const label = 'com.devhost.rc.business.acme-api';
    await rm(join(env.home, 'LaunchDaemons', `${label}.plist`));
    mac.state.loaded.delete(label);
    await writeFile(join(dir, 'compose.yaml'), 'services: { s3: { image: minio/mc } }\n');
    const original = mac.runner.run.bind(mac.runner);
    mac.runner.run = async (cmd, args, opts) =>
      cmd === 'docker' && args.includes('up')
        ? { code: 1, stdout: '', stderr: "Error response from daemon: pull access denied for minio/mc, repository does not exist or may require 'docker login'\n" }
        : original(cmd, args, opts);
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--json')).toBe(1);
    const failed = lastResult(env).errors?.[0] as { code: string; message: string; hint?: string };
    expect(failed.code).toBe('compose-failed');
    expect(failed.message).toContain('pull access denied for minio/mc');
    expect(failed.hint).toContain('Remote Control service runs already: a session in acme-api on claude.ai can fix it');
    expect(mac.state.loaded.has(label)).toBe(true);
  });

  it('compose pulls without the Keychain when Docker Desktop\'s credential helper cannot reach it (ssh, no GUI login)', async () => {
    const { env, mac } = await withAccount();
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc')).toBe(0);
    const dir = join(env.home, 'work', 'business', 'acme-api');
    await writeFile(join(dir, 'compose.yaml'), 'services: { db: { image: postgres } }\n');
    await mkdir(join(env.home, '.docker', 'contexts'), { recursive: true });
    await writeFile(join(env.home, '.docker', 'config.json'), JSON.stringify({ auths: {}, credsStore: 'desktop', currentContext: 'desktop-linux' }));
    const original = mac.runner.run.bind(mac.runner);
    const seen: (string | undefined)[] = [];
    mac.runner.run = async (cmd, args, opts) => {
      if (cmd !== 'docker' || !args.includes('up')) return original(cmd, args, opts);
      seen.push(opts?.env?.['DOCKER_CONFIG']);
      return opts?.env?.['DOCKER_CONFIG']
        ? original(cmd, args, opts)
        : { code: 1, stdout: '', stderr: 'error getting credentials - err: exit status 1, out: `keychain cannot be accessed because the current session does not allow user interaction.`\n' };
    };
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'acme-api')).toBe(0);
    const free = join(env.home, '.local', 'share', 'devhost', 'docker');
    expect(seen).toEqual([undefined, free]);
    expect(mac.state.composeUp.has('devhost-acme-api')).toBe(true);
    expect(JSON.parse(await readFile(join(free, 'config.json'), 'utf8'))).toEqual({ auths: {}, currentContext: 'desktop-linux' });
    expect(await readlink(join(free, 'contexts'))).toBe(join(env.home, '.docker', 'contexts'));
    // The user's own config is left as it is.
    expect(JSON.parse(await readFile(join(env.home, '.docker', 'config.json'), 'utf8')).credsStore).toBe('desktop');
  });

  it('delete without --delete-files leaves the directory', async () => {
    const { env, dir, mac } = await created();
    expect(await env.run('env', 'delete', 'acme-api', '--yes')).toBe(0);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(mac.runner.lines().some((l) => l.includes('docker compose -p devhost-acme-api down'))).toBe(true);
  });

  it('account remove refuses while environments exist, then keeps root, config dir and credentials', async () => {
    const { env, mac } = await created();
    expect(await env.run('account', 'remove', 'business')).toBe(2);
    expect(env.err.join('')).toContain('acme-api');
    expect(env.err.join('')).toContain('devhost env delete acme-api');

    await env.run('env', 'delete', 'acme-api', '--yes');
    env.err.length = 0;
    env.out.length = 0;
    expect(await env.run('account', 'remove', 'business', '--logout', '--json')).toBe(0);
    const data = lastResult(env).data;
    expect(validate('result.account-change', data).ok).toBe(true);
    expect(data).toMatchObject({ action: 'removed' });

    const business = join(env.home, '.claude-business');
    expect((await stat(business)).isDirectory()).toBe(true);
    expect((await stat(join(env.home, 'work', 'business'))).isDirectory()).toBe(true);
    await expect(readFile(join(env.home, 'work', 'business', '.envrc'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(business, 'settings.json'), 'utf8')).not.toContain('account=business');
    expect(await readFile(join(env.home, '.zshrc'), 'utf8')).not.toContain('claude-business');
    expect(await cfg(env)).not.toMatch(/^ *- name: business/m);
    expect(mac.state.loggedIn.has(business)).toBe(false); // --logout ran
    expect(mac.runner.lines()).toContain('/opt/homebrew/bin/claude auth logout');
  });

  it('list: the Remote Control environment link is the last one the service logged', async () => {
    const { env } = await created();
    const listed = async () => {
      env.out.length = 0;
      expect(await env.run('env', 'list', '--json')).toBe(0);
      return (lastEnvelope(env).data as { environments: { remoteControl: { url?: string } }[] }).environments[0]!.remoteControl;
    };
    expect((await listed()).url).toBeUndefined();
    const logs = join(env.home, 'Library', 'Logs', 'devhost');
    await mkdir(logs, { recursive: true });
    const line = (id: string) => `Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_${id}\n\u001b[2K·✔︎· Connected\n`;
    await writeFile(join(logs, 'rc-business-acme-api.log'), `${line('old1')}${'x'.repeat(70_000)}\n${line('New2')}`);
    expect((await listed()).url).toBe('https://claude.ai/code?environment=env_New2');
    const e = lastEnvelope(env);
    expect(validate('result.env-list', e.data).ok).toBe(true);
  });

  it('logs: reads the tail, errors when there is no log yet', async () => {
    const { env } = await created();
    expect(await env.run('env', 'logs', 'acme-api')).toBe(1);
    const logs = join(env.home, 'Library', 'Logs', 'devhost');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'rc-business-acme-api.log'), 'one\ntwo\nthree\n');
    env.out.length = 0;
    expect(await env.run('env', 'logs', 'acme-api', '-n', '2', '--json')).toBe(0);
    const e = lastEnvelope(env);
    expect(validate('result.env-logs', e.data).ok).toBe(true);
    expect((e.data as { lines: string[] }).lines).toEqual(['two', 'three']);
  });

  it('login re-authenticates, accepts trust for existing environments and restarts services', async () => {
    const { env, mac } = await created();
    mac.state.loggedIn.clear();
    mac.state.loaded.clear();
    feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('login', 'business', '--json')).toBe(0);
    const result = lastResult(env);
    expect(validate('result.login', result.data).ok).toBe(true);
    expect(result.data).toMatchObject({ account: 'business', loggedIn: true, restarted: ['acme-api'] });
    expect((result.data as { trusted: string[] }).trusted).toHaveLength(1);
    expect(mac.state.loaded.has('com.devhost.rc.business.acme-api')).toBe(true);
  });

  it("login refuses another account's claude.ai login, and doctor shows who each account is", async () => {
    const { env, mac } = await created();
    await env.run('account', 'add', '--name', 'personal', '--default', '--git-email', 'me@example.com', '--no-login');
    mac.state.loggedIn.add('default');
    mac.state.identities = new Map([['default', 'me@example.com']]);
    mac.state.loginAs = 'me@example.com'; // the browser was signed in to the personal login
    feed(env, { id: 'auth-code', value: 'C' });
    env.out.length = 0;
    expect(await env.run('login', 'business', '--json')).toBe(3);
    expect(lastResult(env).errors![0]!.message).toBe("business signed in as me@example.com, which is personal's login (its environments would show up under personal); signed out again");
    expect(mac.state.loggedIn.has(join(env.home, '.claude-business'))).toBe(false);
    mac.state.loggedIn.add(join(env.home, '.claude-business')); // as if the wrong login had stayed
    mac.state.identities.set(join(env.home, '.claude-business'), 'me@example.com');

    env.out.length = 0;
    await env.run('doctor', '--json');
    const checks = (lastEnvelope(env).data as { checks: { id: string; status: string; message: string; fix?: string }[] }).checks;
    expect(checks.find((c) => c.id === 'account.personal.identity')).toMatchObject({ status: 'ok', message: 'signed in as me@example.com' });
    expect(checks.find((c) => c.id === 'account.business.identity')).toMatchObject({ status: 'fail', message: expect.stringContaining('the same login as personal') });

    mac.state.loginAs = 'a@work.example';
    feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    env.out.length = 0;
    expect(await env.run('login', 'business', '--json')).toBe(0);
  });

  it("login records the account's claude.ai login, refuses another one, and --switch-login starts Remote Control afresh", async () => {
    const { env, mac, dir } = await created();
    const cfgDir = join(env.home, '.claude-business');
    mac.state.identities = new Map();
    mac.state.loginAs = 'a@work.example';
    feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('login', 'business', '--json')).toBe(0);
    expect(await cfg(env)).toContain('claudeLogin: a@work.example');

    // Remote Control state of the first login.
    const pointer = join(cfgDir, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), 'bridge-pointer.json');
    const wtPointer = join(cfgDir, 'projects', `${dir}/.claude/worktrees/bridge-cse_1`.replace(/[^A-Za-z0-9]/g, '-'), 'bridge-pointer.json');
    const other = join(cfgDir, 'projects', '-somewhere-else', 'bridge-pointer.json');
    for (const p of [pointer, wtPointer, other]) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, '{}');
    }
    await writeFile(join(cfgDir, '.claude.json'), JSON.stringify({ remoteControlMachineId: 'm1', keep: 1 }));

    mac.state.loginAs = 'someone@else.example';
    feed(env, { id: 'auth-code', value: 'C' });
    env.out.length = 0;
    expect(await env.run('login', 'business', '--json')).toBe(3);
    expect(lastResult(env).errors![0]!.message).toBe('business signs in as a@work.example, this was someone@else.example; signed out again');
    expect(mac.state.loggedIn.has(cfgDir)).toBe(false);
    await stat(pointer); // untouched

    feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('login', 'business', '--switch-login', '--json')).toBe(0);
    expect(await cfg(env)).toContain('claudeLogin: someone@else.example');
    await expect(stat(pointer)).rejects.toThrow();
    await expect(stat(wtPointer)).rejects.toThrow();
    await stat(other);
    const state = JSON.parse(await readFile(join(cfgDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(state['remoteControlMachineId']).toBeUndefined();
    expect(state['keep']).toBe(1);
  });

  it("login checks the login the services read (.credentials.json), copies a Keychain sign-in there, and starts Remote Control afresh", async () => {
    const { env, mac, dir } = await created();
    const cfgDir = join(env.home, '.claude-business');
    const who: Record<string, string> = { 'tok-old': 'me@example.com', 'tok-new': 'a@work.example' };
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      const email = who[init.headers['Authorization']!.replace('Bearer ', '')];
      return email ? new Response(JSON.stringify({ account: { email }, organization: { uuid: `org-of-${email}` } })) : new Response('', { status: 401 });
    });
    try {
      // The services still have the old login; the Keychain sign-in did not touch their file.
      await writeFile(join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-old' } }));
      const pointer = join(cfgDir, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), 'bridge-pointer.json');
      await mkdir(dirname(pointer), { recursive: true });
      await writeFile(pointer, '{}');
      mac.state.identities = new Map();
      mac.state.loginAs = 'a@work.example';

      feed(env, { id: 'auth-code', value: 'C' });
      env.out.length = 0;
      expect(await env.run('login', 'business', '--json')).toBe(3); // nothing in the Keychain to copy
      expect(lastResult(env).errors![0]!.message).toContain('its services read');

      mac.state.keychain = new Map([[keychainService({ name: 'business', configDir: '~/.claude-business' } as never, env.home), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-new' } })]]);
      feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
      env.out.length = 0;
      expect(await env.run('login', 'business', '--json')).toBe(0);
      expect(JSON.parse(await readFile(join(cfgDir, '.credentials.json'), 'utf8'))).toEqual({ claudeAiOauth: { accessToken: 'tok-new' } });
      expect(((await stat(join(cfgDir, '.credentials.json'))).mode & 0o777).toString(8)).toBe('600');
      await expect(stat(pointer)).rejects.toThrow(); // registered under the old login: forgotten

      await writeFile(join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-old' } }));
      env.out.length = 0;
      await env.run('doctor', '--json');
      expect((lastEnvelope(env).data as { checks: { id: string; status: string; message: string }[] }).checks.find((c) => c.id === 'account.business.identity')).toMatchObject({ status: 'fail', message: expect.stringContaining('its services run as me@example.com') });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('login restarts a service that was already running: it still had the old login', async () => {
    const { env, mac } = await created();
    expect(mac.state.loaded.has('com.devhost.rc.business.acme-api')).toBe(true);
    mac.state.loggedIn.clear();
    feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('login', 'business', '--json')).toBe(0);
    expect(lastResult(env).data).toMatchObject({ restarted: ['acme-api'] });
    expect(env.runner.lines()).toContain('sudo -n -- launchctl kickstart -k system/com.devhost.rc.business.acme-api');
  });

  it("login updates the collector's record, so the dashboard does not wait an hour for its next check", async () => {
    const { env, mac } = await created();
    const db = new Db(dbPath(env.home));
    db.kvSet('auth:business', 'invalid', 1);
    db.close();
    mac.state.loggedIn.clear();
    feed(env, { id: 'auth-code', value: 'C' }, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    expect(await env.run('login', 'business', '--json')).toBe(0);
    const after = new Db(dbPath(env.home), { readonly: true });
    expect(after.kvGet('auth:business')).toBe('ok');
    expect(Number(after.kvGet('auth_checked:business'))).toBeGreaterThan(1);
    after.close();
  });

  it('login: stdin closed during a prompt is a human-action error (exit 3)', async () => {
    const { env } = await withAccount();
    const closed = new PassThrough();
    closed.end();
    env.deps.stdin = closed;
    expect(await env.run('login', 'business', '--json')).toBe(3);
    expect(lastResult(env).errors![0]!.code).toBe('human-action-required');
  });
});
