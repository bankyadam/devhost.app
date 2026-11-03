import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validate, type DoctorData, type Envelope } from '@devhost/contract';
import { Db, dbPath } from '../src/collector/db.js';
import { AlertEngine } from '../src/collector/alerts.js';
import { fakeMac, makeEnv, mountVolume, ndjson, type FakeVolume, type TestEnv } from './helpers.js';

const UUID = '6F1C2A44-9B3E-4C5D-8E7F-0123456789AB';
const cfg = (env: TestEnv) => readFile(join(env.home, '.config', 'devhost', 'config.yaml'), 'utf8');
const lastEnvelope = (env: TestEnv): Envelope => JSON.parse(env.stdout().trim().split('\n').at(-1)!) as Envelope;
const lastResult = (env: TestEnv) => ndjson(env.stdout()).at(-1) as { type: string; ok: boolean; data: Record<string, unknown>; errors?: { code: string; message: string }[] };
const plist = (env: TestEnv, label: string) => readFile(join(env.home, 'LaunchDaemons', `${label}.plist`), 'utf8');

const trust = (env: TestEnv): void => stdinOf(env, [{ id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true }].map((a) => JSON.stringify(a)).join('\n') + '\n');

function stdinOf(env: TestEnv, text: string): void {
  const s = new PassThrough();
  env.deps.stdin = s;
  s.end(text);
}

/** A converged host with a business account and environment on the internal disk, and an external volume plugged in. */
async function setup(o: { encrypted?: boolean } = {}) {
  const mac = fakeMac();
  const env = await makeEnv(mac.runner);
  env.deps.env['DEVHOST_TRUST_IDLE_MS'] = '30';
  await env.run('init', '--yes', '--no-tailscale');
  await env.run('apply');
  await env.run('account', 'add', '--name', 'business', '--git-email', 'a@work.example', '--no-login');
  mac.state.loggedIn.add(join(env.home, '.claude-business'));
  await env.run('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
  const volumes = join(env.home, 'Volumes');
  const v: FakeVolume = { uuid: UUID, name: 'devwork', device: 'disk5s1', mountPoint: null, encrypted: o.encrypted === true, ownership: false };
  mac.state.volumes = [v];
  mountVolume(volumes, v, true);
  env.out.length = 0;
  env.err.length = 0;
  return { env, mac, v, volumes, mount: join(volumes, 'devwork') };
}

describe('external work volume (spec A7.12)', () => {
  it('lists external disks; adopt writes the config and the marker; new accounts land on the volume; apply sets it up; doctor is green', async () => {
    const { env, mac, mount } = await setup();
    expect(await env.run('storage', 'list', '--json')).toBe(0);
    const list = lastEnvelope(env).data;
    expect(validate('result.storage-list', list).ok).toBe(true);
    expect(list).toMatchObject({ disks: [{ device: 'disk4', volumes: [{ device: 'disk5s1', name: 'devwork', uuid: UUID }] }] });

    env.out.length = 0;
    expect(await env.run('storage', 'adopt', 'disk5s1', '--json')).toBe(0);
    expect(validate('result.storage-change', lastResult(env).data).ok).toBe(true);
    expect(await readFile(join(mount, '.devhost-volume'), 'utf8')).toBe(`${UUID}\n`);
    const text = await cfg(env);
    expect(text).toContain(`uuid: ${UUID}`);
    expect(text).toContain(`root: ${mount}/work`);
    expect(text).toMatch(/diskGiB: 80/);

    await env.run('account', 'add', '--name', 'side', '--git-email', 's@example.com', '--no-login');
    expect(await cfg(env)).toContain(`root: ${mount}/work/side`);

    env.out.length = 0;
    expect(await env.run('apply', '--json')).toBe(0);
    expect(mac.state.automount).toBe(true);
    expect(mac.state.volumes![0]!.ownership).toBe(true);
    expect(mac.state.spotlightOff?.has(mount)).toBe(true);
    expect(existsSync(join(mount, 'work', 'side'))).toBe(true);
    // Colima mounts the volume's root, writable.
    expect(await plist(env, 'com.devhost.colima')).toContain(`<string>${mount}/work:w</string>`);

    env.out.length = 0;
    await env.run('doctor', '--json');
    const checks = (lastEnvelope(env).data as DoctorData).checks.filter((c) => c.id.startsWith('storage.'));
    expect(checks.filter((c) => c.status !== 'ok' && !['storage.roots', 'storage.docker-disk'].includes(c.id))).toEqual([]);
    expect(checks.find((c) => c.id === 'storage.docker-disk')).toMatchObject({ status: 'warn' }); // the fake's internal disk is tiny
    expect(checks.find((c) => c.id === 'storage.roots')).toMatchObject({ status: 'warn', message: expect.stringContaining('business') }); // still on the internal disk
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(['storage.volume', 'storage.ownership', 'storage.spotlight', 'storage.automount', 'storage.colima-mount', 'storage.colima-files']));

    mac.state.colimaSeesVolume = false;
    env.out.length = 0;
    await env.run('doctor', '--json');
    expect((lastEnvelope(env).data as DoctorData).checks.find((c) => c.id === 'storage.colima-files')).toMatchObject({ status: 'fail' });
  });

  it('only services of environments on the volume wait for it; the others keep their plist and are not restarted', async () => {
    const { env, mac, mount } = await setup();
    trust(env);
    expect(await env.run('env', 'create', '--account', 'business', '--name', 'billing', '--json')).toBe(0);
    const before = await plist(env, 'com.devhost.rc.business.billing');
    await env.run('storage', 'adopt', UUID);
    await env.run('account', 'add', '--name', 'side', '--git-email', 's@example.com', '--no-login');
    mac.state.loggedIn.add(join(env.home, '.claude-side'));
    trust(env);
    expect(await env.run('env', 'create', '--account', 'side', '--name', 'blog', '--json')).toBe(0);
    mac.runner.calls.length = 0;
    expect(await env.run('apply')).toBe(0);

    expect(await plist(env, 'com.devhost.rc.business.billing')).toBe(before); // internal disk: byte for byte
    expect(mac.runner.lines().some((l) => /bootout system\/com\.devhost\.rc\.business\.billing/.test(l))).toBe(false);
    const blog = await plist(env, 'com.devhost.rc.side.blog');
    expect(blog).toContain('storage wait --timeout 120 --config');
    expect(blog).toContain(`<string>${mount}/work/side/blog</string>`);

    // A second apply with the volume unchanged restarts nothing.
    mac.runner.calls.length = 0;
    expect(await env.run('apply')).toBe(0);
    expect(mac.runner.lines().some((l) => /bootout|kickstart -k/.test(l))).toBe(false);
  });

  it('wait, guards and status: an unmounted volume is never written to and is reported', async () => {
    const { env, mac, v, volumes, mount } = await setup();
    await env.run('storage', 'adopt', 'disk5s1');
    await env.run('account', 'add', '--name', 'side', '--git-email', 's@example.com', '--no-login');
    expect(await env.run('storage', 'wait', '--timeout', '0')).toBe(0);

    mountVolume(volumes, v, false); // unplugged: the empty mount directory is left behind, as macOS would leave it gone
    await (await import('node:fs/promises')).rm(mount, { recursive: true, force: true });
    expect(await env.run('storage', 'wait', '--timeout', '0')).toBe(1);
    env.out.length = 0;
    expect(await env.run('storage', 'status', '--json')).toBe(1);
    const st = lastEnvelope(env).data;
    expect(validate('result.storage-status', st).ok).toBe(true);
    expect(st).toMatchObject({ configured: true, volume: { mounted: false, ready: false } });

    // Creating an environment on the volume refuses instead of writing to the internal disk.
    mac.state.loggedIn.add(join(env.home, '.claude-side'));
    expect(await env.run('env', 'create', '--account', 'side', '--name', 'blog', '--no-rc')).not.toBe(0);
    expect(existsSync(mount)).toBe(false);

    // A stray directory in its place is reported, and still never written into.
    await mkdir(mount);
    env.out.length = 0;
    await env.run('doctor', '--json');
    expect((lastEnvelope(env).data as DoctorData).checks.find((c) => c.id === 'storage.stray')).toMatchObject({ status: 'fail' });
    expect(await env.run('env', 'create', '--account', 'side', '--name', 'blog', '--no-rc')).not.toBe(0);
    expect(await readdir(mount)).toEqual([]);
  });

  it('an encrypted volume: the passphrase goes through stdin only, into the System keychain; apply installs the unlock service', async () => {
    const PASS = 'correct "horse" \\ battery-7319';
    const { env, mac } = await setup({ encrypted: true });
    await env.run('storage', 'adopt', 'disk5s1');
    expect(await cfg(env)).toContain('encrypted: true');
    expect(await env.run('apply')).toBe(3); // no passphrase yet: a human step
    stdinOf(env, `${PASS}\n`);
    expect(await env.run('storage', 'set-passphrase')).toBe(0);
    expect(mac.state.volumePassphrase).toBe(PASS);
    expect(await env.run('apply')).toBe(0);
    const unlock = await plist(env, 'com.devhost.storage.unlock');
    expect(unlock).toContain(UUID);
    expect(unlock).toContain('-stdinpassphrase');
    expect(unlock).not.toContain('<key>UserName</key>'); // root: it reads the System keychain

    // Nowhere but the keychain: not in argv, output, config, plists, the database.
    const files = [await cfg(env), unlock, existsSync(dbPath(env.home)) ? await readFile(dbPath(env.home), 'latin1') : ''];
    for (const text of [...files, env.stdout(), env.err.join(''), mac.runner.lines().join('\n')]) expect(text).not.toContain('battery-7319');
  });

  it('storage.unlock compares the volume UUID in the installed plist, and removes the service when no encrypted volume is configured', async () => {
    const { env, mac } = await setup({ encrypted: true });
    await env.run('storage', 'adopt', 'disk5s1');
    stdinOf(env, 'pw\n');
    await env.run('storage', 'set-passphrase');
    expect(await env.run('apply')).toBe(0);
    const file = join(env.home, 'LaunchDaemons', 'com.devhost.storage.unlock.plist');
    // Another volume's plist in place: apply must rewrite it.
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll(UUID, '11111111-2222-3333-4444-555555555555'));
    env.out.length = 0;
    expect(await env.run('apply', '--json')).toBe(0);
    expect(ndjson(env.stdout()).some((e) => (e as { id?: string; status?: string }).id === 'storage.unlock' && (e as { status?: string }).status === 'changed')).toBe(true);
    expect(await readFile(file, 'utf8')).toContain(UUID);

    // The volume is no longer encrypted: the service goes.
    await writeFile(join(env.home, '.config', 'devhost', 'config.yaml'), (await cfg(env)).replace('encrypted: true', 'encrypted: false'));
    expect(await env.run('apply')).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(mac.state.loaded.has('com.devhost.storage.unlock')).toBe(false);
  });

  it('migrate moves an account onto the volume, regenerates what names the path, keeps the old copy until --cleanup', async () => {
    const { env, mount } = await setup();
    await env.run('storage', 'adopt', 'disk5s1');
    const old = join(env.home, 'work', 'business');
    await writeFile(join(old, 'acme-api', 'README.md'), 'hello\n');
    env.out.length = 0;
    expect(await env.run('storage', 'migrate', '--account', 'business', '--yes', '--json')).toBe(0);
    const data = lastResult(env).data;
    expect(validate('result.storage-change', data).ok).toBe(true);
    expect(data).toMatchObject({ action: 'migrated', from: old, to: `${mount}/work/business`, environments: ['acme-api'] });
    expect(await readFile(join(mount, 'work', 'business', 'acme-api', 'README.md'), 'utf8')).toBe('hello\n');
    expect(await cfg(env)).toContain(`root: ${mount}/work/business`);
    expect(await readFile(join(mount, 'work', 'business', '.envrc'), 'utf8')).toContain('CLAUDE_CONFIG_DIR');
    expect(await readFile(join(env.home, '.gitconfig'), 'utf8')).toContain(`gitdir:${mount}/work/business/`);
    expect(existsSync(old)).toBe(true); // kept

    expect(await env.run('storage', 'migrate', '--account', 'business', '--cleanup', '--yes')).toBe(0);
    expect(existsSync(old)).toBe(false);
  });

  it('prepare is refused without --yes-erase and the identifier typed back', async () => {
    const { env } = await setup();
    expect(await env.run('storage', 'prepare', 'disk4', '--label', 'devwork')).toBe(2);
    stdinOf(env, `${JSON.stringify({ id: 'confirm-disk', value: 'disk9' })}\n`);
    expect(await env.run('storage', 'prepare', 'disk4', '--label', 'devwork', '--yes-erase', '--json')).toBe(3);
    expect(lastResult(env).errors![0]!.message).toContain('nothing was erased');
  });

  it('the collector alerts once per state change when the volume goes away and comes back', async () => {
    const { env } = await setup();
    const db = new Db(dbPath(env.home));
    const sent: string[] = [];
    const alerts = new AlertEngine(db, { send: async (n: { title?: string; message?: string }) => void sent.push(`${n.title ?? ''} ${n.message ?? ''}`) } as never, () => 1);
    const thresholds = { memoryPercent: 90, diskFreePercent: 15, dailyCostUsd: new Map() };
    const base = { memPct: null, diskFreePct: null, costToday: new Map(), restarts: new Map(), auth: new Map() };
    const vol = (mounted: boolean) => ({ ...base, volume: { label: 'devwork', mountPoint: '/Volumes/devwork', mounted, identityOk: true, doubleMount: false, strayDirectory: false, freePct: 50, freeLimit: 15 } });
    await alerts.evaluate(thresholds, vol(false));
    await alerts.evaluate(thresholds, vol(false));
    await alerts.evaluate(thresholds, vol(true));
    db.close();
    expect(sent.filter((t) => /devwork/.test(t))).toHaveLength(2); // gone, back
  });
});
