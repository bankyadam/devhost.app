import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validate } from '@devhost/contract';
import type { ApplyData, Envelope } from '@devhost/contract';
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
    expect(mac.runner.spawned.filter((s) => s.call.command === 'script')).toEqual([]);
    const trust = (ndjson(env.stdout()) as { type: string; id?: string; status?: string }[]).filter((e) => e.type === 'step' && e.id === 'trust.acme-api');
    expect(trust.at(-1)).toMatchObject({ status: 'ok' });
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
    const trust = mac.runner.spawned.find((s) => s.call.command === 'script')!;
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
