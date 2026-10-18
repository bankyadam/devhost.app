import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate, type DoctorData, type Envelope } from '@devhost/contract';
import { parsePluginSource } from '../src/plugins/install.js';
import { fakeMac, makeEnv, ndjson, type TestEnv } from './helpers.js';

const lastEnvelope = (env: TestEnv): Envelope => JSON.parse(env.stdout().trim().split('\n').at(-1)!) as Envelope;
const lastResult = (env: TestEnv) => ndjson(env.stdout()).at(-1) as { type: string; ok: boolean; data: Record<string, unknown>; errors?: { code: string; message: string }[] };

const HELLO = `
export default {
  name: 'hello',
  version: '1.0.0',
  description: 'a test plugin',
  actions: [
    { id: 'greet', title: 'Greet', description: 'writes a file', scope: 'host',
      async run(ctx) {
        await ctx.exec.writeText(ctx.home + '/hello.txt', 'hi ' + ctx.options.who + '\\n');
        return { summary: 'greeted ' + ctx.options.who, data: { environments: ctx.environments.length } };
      } },
    { id: 'wipe', title: 'Wipe everything', description: 'asks first', scope: 'host', destructive: true,
      async run() { return { summary: 'wiped' }; } },
    { id: 'env', title: 'Env thing', description: 'per environment', scope: 'environment',
      async run(ctx, t) { return { summary: 'env ' + t.environment.name + ' in ' + t.environment.dir }; } },
  ],
  checks: [{ id: 'mood', async run(ctx) { return { status: 'warn', message: 'hello says ' + ctx.options.who, fix: 'cheer up' }; } }],
};
`;

async function withPlugin(source = HELLO, name = 'hello') {
  const env = await makeEnv(fakeMac().runner);
  await env.run('init', '--yes', '--no-tailscale');
  const dir = join(env.home, '.config', 'devhost', 'plugins', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.js'), source);
  env.out.length = 0;
  return env;
}

const enable = (env: TestEnv, name = 'hello') => env.run('config', 'set', `/plugins/${name}`, '{"enabled":true,"options":{"who":"adam"}}');

describe('plugins', () => {
  it('a plugin you added stays off until it is enabled; then its actions and checks are listed', async () => {
    const env = await withPlugin();
    expect(await env.run('plugin', 'list', '--json')).toBe(0);
    let hello = (lastEnvelope(env).data as { plugins: { name: string; enabled: boolean; actions: unknown[] }[] }).plugins.find((p) => p.name === 'hello')!;
    expect(hello).toMatchObject({ enabled: false, actions: [] });
    expect(await env.run('plugin', 'run', 'hello', 'greet')).toBe(2);

    await enable(env);
    env.out.length = 0;
    expect(await env.run('plugin', 'list', '--json')).toBe(0);
    const e = lastEnvelope(env);
    expect(validate('result.plugin-list', e.data).ok).toBe(true);
    hello = (e.data as { plugins: typeof hello[] }).plugins.find((p) => p.name === 'hello')!;
    expect(hello).toMatchObject({ enabled: true, builtin: false, version: '1.0.0', checks: ['mood'] });
    expect(hello.actions).toEqual([
      { id: 'greet', title: 'Greet', description: 'writes a file', scope: 'host', destructive: false },
      { id: 'wipe', title: 'Wipe everything', description: 'asks first', scope: 'host', destructive: true },
      { id: 'env', title: 'Env thing', description: 'per environment', scope: 'environment', destructive: false },
    ]);
  });

  it('runs an action with its options; --dry-run only plans', async () => {
    const env = await withPlugin();
    await enable(env);
    env.out.length = 0;
    expect(await env.run('plugin', 'run', 'hello', 'greet', '--dry-run', '--json')).toBe(0);
    let r = lastResult(env);
    expect(validate('result.plugin-run', r.data).ok).toBe(true);
    expect(r.data).toMatchObject({ plugin: 'hello', action: 'greet', dryRun: true, summary: 'greeted adam', plan: [{ stepId: 'plugin.hello.greet', action: `write ${env.home}/hello.txt`, sudo: false }] });
    await expect(readFile(join(env.home, 'hello.txt'), 'utf8')).rejects.toThrow();
    env.out.length = 0;
    expect(await env.run('plugin', 'run', 'hello', 'greet', '--json')).toBe(0);
    r = lastResult(env);
    expect(r.data).toMatchObject({ dryRun: false, data: { environments: 0 } });
    expect(await readFile(join(env.home, 'hello.txt'), 'utf8')).toBe('hi adam\n');
  });

  it('an action that removes something asks first; --yes answers; scopes need their target', async () => {
    const env = await withPlugin();
    await enable(env);
    expect(await env.run('plugin', 'run', 'hello', 'wipe')).toBe(3); // no terminal to ask in
    expect(await env.run('plugin', 'run', 'hello', 'wipe', '--yes')).toBe(0);
    expect(env.stdout()).toContain('wiped');
    expect(await env.run('plugin', 'run', 'hello', 'env')).toBe(2);
    expect(await env.run('plugin', 'run', 'hello', 'greet', '--env', 'x')).toBe(2);
    expect(await env.run('plugin', 'run', 'hello', 'nope')).toBe(2);
    expect(await env.run('plugin', 'run', 'nope', 'greet')).toBe(2);
  });

  it("doctor shows the plugin's checks, and a plugin that does not load as a warning", async () => {
    const env = await withPlugin();
    await enable(env);
    await mkdir(join(env.home, '.config', 'devhost', 'plugins', 'broken'), { recursive: true });
    await writeFile(join(env.home, '.config', 'devhost', 'plugins', 'broken', 'index.js'), 'export default { nope: 1 };');
    await enable(env, 'broken');
    env.out.length = 0;
    await env.run('doctor', '--json');
    const checks = (JSON.parse(env.stdout()) as { data: DoctorData }).data.checks;
    expect(checks.find((c) => c.id === 'plugin.hello.mood')).toEqual({ id: 'plugin.hello.mood', status: 'warn', message: 'hello says adam', fix: 'cheer up' });
    expect(checks.find((c) => c.id === 'plugin.broken')).toMatchObject({ status: 'warn', message: expect.stringContaining('not a devhost plugin') });
  });
});

const ADVISOR = `
export default {
  name: 'advisor',
  version: '1.0.0',
  description: 'advice and widgets',
  actions: [{ id: 'fix', title: 'Fix it', description: 'fixes', scope: 'host', async run() { return { summary: 'fixed' }; } }],
  advice: [
    { check: 'plugin.hello.*', async run(ctx, c) { return { message: 'seen ' + c.id + ' (' + c.status + ')', action: 'fix' }; } },
    { check: 'plugin.hello.mood', on: ['ok'], async run() { return { message: 'never: mood is a warning' }; } },
    { check: 'system.macos', on: ['ok', 'warn', 'fail'], async run() { return null; } },
    { check: 'plugin.hello.mood', async run() { throw new Error('boom'); } },
  ],
  widgets: [
    { id: 'space', title: 'Space', async run(ctx) {
      return { status: 'warn', summary: 'for ' + ctx.options.who, tiles: [{ label: 'Cache', value: '1 GB', sub: 'npm' }], rows: [{ label: 'old', value: '2 MB', note: 'pushed' }], action: 'fix' };
    } },
    { id: 'broken', title: 'Broken', async run() { throw new Error('no data'); } },
  ],
};
`;

describe('plugin advice and widgets', () => {
  it("doctor puts a plugin's advice under the check it speaks to, by pattern and status; advice that throws says so", async () => {
    const env = await withPlugin();
    await enable(env);
    const dir = join(env.home, '.config', 'devhost', 'plugins', 'advisor');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.js'), ADVISOR);
    await enable(env, 'advisor');
    env.out.length = 0;
    await env.run('doctor', '--json');
    const data = (JSON.parse(env.stdout()) as { data: DoctorData }).data;
    expect(validate('result.doctor', data).ok).toBe(true);
    expect(data.checks.find((c) => c.id === 'plugin.hello.mood')!.advice).toEqual([
      { plugin: 'advisor', message: 'seen plugin.hello.mood (warn)', fix: 'devhost plugin run advisor fix', action: 'fix' },
      { plugin: 'advisor', message: 'advice crashed: boom' },
    ]);
    expect(data.checks.find((c) => c.id === 'system.macos')!.advice).toBeUndefined();

    env.out.length = 0;
    await env.run('doctor');
    expect(env.stdout()).toContain('     advisor: seen plugin.hello.mood (warn)\n       fix: devhost plugin run advisor fix');
  });

  it('plugin widgets lists the enabled plugins\' cards; one that throws carries its error', async () => {
    const env = await withPlugin(ADVISOR, 'advisor');
    expect(await env.run('plugin', 'widgets', '--json')).toBe(0);
    expect((lastEnvelope(env).data as { widgets: unknown[] }).widgets).toEqual([]); // off until enabled
    await enable(env, 'advisor');
    env.out.length = 0;
    expect(await env.run('plugin', 'widgets', '--json')).toBe(0);
    const data = lastEnvelope(env).data;
    expect(validate('result.plugin-widgets', data).ok).toBe(true);
    expect(data).toEqual({
      widgets: [
        { plugin: 'advisor', id: 'space', title: 'Space', status: 'warn', summary: 'for adam', tiles: [{ label: 'Cache', value: '1 GB', sub: 'npm' }], rows: [{ label: 'old', value: '2 MB', note: 'pushed' }], action: 'fix' },
        { plugin: 'advisor', id: 'broken', title: 'Broken', error: 'no data' },
      ],
    });
  });
});

describe('plugin install / uninstall', () => {
  it('understands GitHub URLs, owner/repo and refs, and refuses anything that could be an option', () => {
    expect(parsePluginSource('bankyadam/devhost-plugin-disk-cleanup')).toEqual({ spec: 'bankyadam/devhost-plugin-disk-cleanup', url: 'https://github.com/bankyadam/devhost-plugin-disk-cleanup.git', name: 'disk-cleanup' });
    expect(parsePluginSource('https://github.com/a/b-tool/tree/v1.2')).toMatchObject({ url: 'https://github.com/a/b-tool.git', ref: 'v1.2', name: 'b-tool' });
    expect(parsePluginSource('https://github.com/a/devhost-x.git#main')).toMatchObject({ url: 'https://github.com/a/devhost-x.git', ref: 'main', name: 'x' });
    expect(parsePluginSource('git@github.com:a/My_Plugin.git', 'mine')).toMatchObject({ url: 'git@github.com:a/My_Plugin.git', name: 'mine' });
    for (const bad of ['--upload-pack=evil', 'a b', '', 'not a url', 'https://github.com/a/b#$(x)']) expect(() => parsePluginSource(bad), bad).toThrow();
  });

  /** The fake Mac plus a `git clone` that copies a fixture repository. */
  async function installable(fixture: string) {
    const mac = fakeMac();
    const original = mac.runner.run.bind(mac.runner);
    mac.runner.run = async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'clone') {
        await cp(fixture, args.at(-1)!, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args.includes('rev-parse')) return { code: 0, stdout: 'abc123def4567890\n', stderr: '' };
      if (cmd === 'mv') {
        await rename(args[0]!, args[1]!);
        return { code: 0, stdout: '', stderr: '' };
      }
      return original(cmd, args, opts);
    };
    const runner = mac.runner;
    const env = await makeEnv(runner);
    await env.run('init', '--yes', '--no-tailscale');
    env.out.length = 0;
    return env;
  }

  it('installs from GitHub switched off, records where from; enable turns it on; uninstall removes it and its entry', async () => {
    const fixture = join(await import('node:os').then((o) => o.tmpdir()), `fixture-${Date.now()}`);
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'index.js'), HELLO);
    const env = await installable(fixture);
    expect(await env.run('plugin', 'install', 'someone/devhost-plugin-hello', '--json')).toBe(0);
    expect(lastResult(env).data).toMatchObject({ name: 'hello', action: 'installed', enabled: false, url: 'https://github.com/someone/devhost-plugin-hello.git', commit: 'abc123def4567890' });
    env.out.length = 0;
    await env.run('plugin', 'list', '--json');
    const listed = (lastEnvelope(env).data as { plugins: { name: string; enabled: boolean; installedFrom?: object }[] }).plugins.find((p) => p.name === 'hello')!;
    expect(listed).toMatchObject({ enabled: false, installedFrom: { url: 'https://github.com/someone/devhost-plugin-hello.git', commit: 'abc123def4567890' } });
    expect(await env.run('plugin', 'install', 'someone/devhost-plugin-hello')).toBe(2); // already there

    expect(await env.run('plugin', 'enable', 'hello')).toBe(0);
    expect(await readFile(join(env.home, '.config', 'devhost', 'config.yaml'), 'utf8')).toMatch(/plugins:[\s\S]*hello:[\s\S]*enabled: true/);
    env.out.length = 0;
    expect(await env.run('plugin', 'run', 'hello', 'wipe', '--yes')).toBe(0);

    expect(await env.run('plugin', 'uninstall', 'hello', '--json')).toBe(0);
    await expect(stat(join(env.home, '.config', 'devhost', 'plugins', 'hello'))).rejects.toThrow();
    expect(await readFile(join(env.home, '.config', 'devhost', 'config.yaml'), 'utf8')).not.toMatch(/hello:/);
    expect(await env.run('plugin', 'uninstall', 'hello')).toBe(2); // not installed any more
    expect(await env.run('plugin', 'disable', 'nope')).toBe(2);
  });

  it("npm runs only for real dependencies, with devhost's Node first on PATH (ssh has no nvm Node)", async () => {
    const fixture = join(await import('node:os').then((o) => o.tmpdir()), `deps-${Date.now()}`);
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'index.js'), HELLO);
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'devhost-plugin-hello', type: 'module', dependencies: { yaml: '^2' } }));
    const env = await installable(fixture);
    const npmCalls: { cmd: string; path?: string }[] = [];
    const inner = env.runner.run.bind(env.runner);
    env.runner.run = async (cmd, args, opts) => {
      if (cmd.endsWith('npm')) {
        npmCalls.push({ cmd, path: opts?.env?.['PATH'] });
        return { code: 0, stdout: '', stderr: '' };
      }
      return inner(cmd, args, opts);
    };
    expect(await env.run('plugin', 'install', 'someone/devhost-plugin-hello')).toBe(0);
    expect(npmCalls).toHaveLength(1);
    expect(npmCalls[0]!.path?.startsWith(`${dirname(env.deps.nodePath)}:`)).toBe(true);
  });

  it('a repository without index.js is not installed, and leaves nothing behind', async () => {
    const fixture = join(await import('node:os').then((o) => o.tmpdir()), `empty-${Date.now()}`);
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'README.md'), 'nothing here');
    const env = await installable(fixture);
    expect(await env.run('plugin', 'install', 'someone/empty', '--json')).toBe(1);
    expect(lastResult(env).errors?.[0]?.message).toContain('has no index.js');
    await expect(stat(join(env.home, '.config', 'devhost', 'plugins', '.installing-empty'))).rejects.toThrow();
    await expect(stat(join(env.home, '.config', 'devhost', 'plugins', 'empty'))).rejects.toThrow();
  });
});

