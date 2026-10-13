import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplyData } from '@devhost/contract';
import { managedSettings, mergeSettings, parseSettings, removeManaged } from '../src/claude-settings.js';
import { renderPlist } from '../src/launchd.js';
import { gitconfigBlockBody } from '../src/steps/git.js';
import { shellBlockBody } from '../src/steps/shell.js';
import { markdownBlock } from '../src/steps/shellblock.js';
import { parseConfig } from '../src/config/load.js';
import { fakeMac, makeEnv, ndjson } from './helpers.js';

const withAccounts = (home: string): string => `
machine: { hostname: macmini }
notify: { topic: devhost-abcdefgh }
accounts:
  - name: personal
    default: true
    root: ${home}/work/personal
    portRange: [3000, 3999]
    git: { name: "Ada Lovelace", email: ada@example.com }
  - name: business
    configDir: ${home}/.claude-business
    root: ${home}/work/business
    portRange: [4000, 4999]
    git: { name: "Ada L", email: ada@work.example }
`;

async function setup() {
  const mac = fakeMac();
  const env = await makeEnv(mac.runner);
  await env.run('init', '--yes');
  const path = join(env.home, '.config', 'devhost', 'config.yaml');
  const base = await readFile(path, 'utf8');
  const accounts = withAccounts(env.home);
  // Keep the generated file but swap in accounts.
  await writeFile(path, base.replace('accounts: []', accounts.split('accounts:')[1]!.replace(/^/, 'accounts:')));
  env.out.length = 0;
  return { env, mac, path };
}

describe('claude settings merge', () => {
  const config = parseConfig('machine: { hostname: m }\nnotify: { topic: devhost-abcdefgh }', '/x');
  const managed = managedSettings(config, { name: 'business' });

  it('writes telemetry env, allowedHttpHookUrls and hooks (SessionStart via command, the rest HTTP)', () => {
    expect(managed['env']).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    });
    expect(managed['allowedHttpHookUrls']).toEqual(['http://127.0.0.1:4318/hooks*']);
    const hooks = managed['hooks'] as Record<string, { hooks: { type: string; url?: string; command?: string }[] }[]>;
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks['SessionStart']![0]!.hooks[0]!.type).toBe('command');
    expect(hooks['SessionStart']![0]!.hooks[0]!.command).toContain('http://127.0.0.1:4318/hooks?account=business');
    expect(hooks['Stop']![0]!.hooks[0]).toMatchObject({ type: 'http', url: 'http://127.0.0.1:4318/hooks?account=business' });
    // Privacy: no prompt/response logging switches.
    expect(JSON.stringify(managed)).not.toMatch(/OTEL_LOG_/);
    expect(managed).toMatchObject({ remoteControlAtStartup: true, permissions: { defaultMode: 'acceptEdits' } });
  });

  it('keeps user keys and hooks, is idempotent, and does not duplicate hooks', () => {
    const mine = {
      theme: 'dark',
      env: { FOO: '1' },
      permissions: { ask: ['Bash(rm *)'], allow: ['Read'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    };
    const once = mergeSettings(mine, managed, 4318);
    expect(once['theme']).toBe('dark');
    expect(once['env']).toMatchObject({ FOO: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
    expect((once['permissions'] as { ask: string[] }).ask).toEqual(['Bash(rm *)', 'Bash(git commit *)', 'Bash(git push *)']);
    expect((once['hooks'] as { Stop: unknown[] }).Stop).toHaveLength(2);
    expect(mergeSettings(once, managed, 4318)).toEqual(once);
  });

  it('removes only what it added', () => {
    const mine = { theme: 'dark', env: { FOO: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    const merged = mergeSettings(mine, managed, 4318);
    expect(removeManaged(merged, managed, 4318)).toEqual(mine);
  });

  it('refuses to touch a settings.json that is not valid JSON', () => {
    expect(() => parseSettings('{ nope', '/x/settings.json')).toThrow(/not valid JSON/);
    expect(parseSettings(null, '/x')).toEqual({});
  });
});

describe('plist', () => {
  it('renders and XML-escapes', async () => {
    const text = await renderPlist(
      { label: 'com.devhost.rc.a.b', args: ['/opt/homebrew/bin/claude', 'remote-control', '--name', 'a&b<c>'], workingDirectory: '/w', env: { HOME: '/Users/x', ZED: '1' }, logPath: '/l.log' },
      'adam',
    );
    expect(text).toContain('<key>UserName</key>\n  <string>adam</string>');
    expect(text).toContain('<string>a&amp;b&lt;c&gt;</string>');
    expect(text).toContain('<key>HOME</key>\n    <string>/Users/x</string>');
    expect(text).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(text).toContain('<integer>30</integer>');
  });
});

describe('blocks', () => {
  it('shell block gets direnv hook and one alias per account', () => {
    const config = parseConfig(withAccounts('/Users/x'), '/c');
    const body = shellBlockBody(config, '/Users/x', '/opt/homebrew');
    expect(body).toContain('command -v direnv >/dev/null 2>&1 && eval "$(direnv hook zsh)"');
    expect(body).toContain("alias claude-personal='env -u CLAUDE_CONFIG_DIR claude'");
    expect(body).toContain("alias claude-business='CLAUDE_CONFIG_DIR=/Users/x/.claude-business claude'");
  });

  it('gitconfig block has one includeIf per account root', () => {
    const config = parseConfig(withAccounts('/Users/x'), '/c');
    expect(gitconfigBlockBody(config, '/Users/x')).toEqual([
      '[includeIf "gitdir:/Users/x/work/personal/"]',
      '\tpath = /Users/x/.config/devhost/git/personal.gitconfig',
      '[includeIf "gitdir:/Users/x/work/business/"]',
      '\tpath = /Users/x/.config/devhost/git/business.gitconfig',
    ]);
  });

  it('markdown block keeps user content around it', () => {
    const out = markdownBlock.upsert('# Mine\n\nHello\n', ['## Working rules', '- x']);
    expect(out).toContain('# Mine');
    expect(markdownBlock.read(out)).toEqual(['## Working rules', '- x']);
    expect(markdownBlock.remove(out)).toBe('# Mine\n\nHello\n');
  });
});

describe('apply with accounts', () => {
  it('configures docker, tailscale, claude, accounts; the second apply changes nothing', async () => {
    const { env, mac } = await setup();
    await mkdir(join(env.home, 'work'), { recursive: true });
    expect(await env.run('apply', '--json')).toBe(0);
    const first = (ndjson(env.stdout()).at(-1) as { data: ApplyData }).data;
    expect(first.changed).toBe(true);
    expect(first.steps.every((s) => s.status !== 'failed')).toBe(true);
    expect(first.warnings?.join(' ')).toContain('Tailscale is not logged in');
    expect(mac.state.colimaRunning).toBe(true);
    expect(mac.state.loaded.has('com.devhost.colima')).toBe(true);
    expect(mac.state.tailscale).toBe('NeedsLogin');

    // Per-account files
    const business = join(env.home, '.claude-business');
    const settings = JSON.parse(await readFile(join(business, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings['remoteControlAtStartup']).toBe(true);
    expect(JSON.stringify(settings)).toContain('account=business');
    expect(await readFile(join(env.home, '.claude', 'settings.json'), 'utf8')).toContain('account=personal');
    expect(await readFile(join(business, 'CLAUDE.md'), 'utf8')).toContain('$DEVHOST_PORT_BASE');
    expect(await readFile(join(env.home, 'work', 'business', '.envrc'), 'utf8')).toContain(`export CLAUDE_CONFIG_DIR=${business}`);
    await expect(readFile(join(env.home, 'work', 'personal', '.envrc'), 'utf8')).rejects.toThrow(); // default account: no .envrc
    expect(mac.state.direnvAllowed.has(join(env.home, 'work', 'business'))).toBe(true);
    expect(await readFile(join(env.home, '.gitconfig'), 'utf8')).toContain('includeIf "gitdir:' + join(env.home, 'work', 'business') + '/"');
    expect(await readFile(join(env.home, '.config', 'devhost', 'git', 'business.gitconfig'), 'utf8')).toContain('email = "ada@work.example"');
    expect(await readFile(join(env.home, '.zshrc'), 'utf8')).toContain('alias claude-business=');
    expect(JSON.parse(await readFile(join(env.home, '.config', 'devhost', 'state.json'), 'utf8'))).toMatchObject({ claudePath: '/opt/homebrew/bin/claude' });
    expect(JSON.parse(await readFile(join(env.home, '.docker', 'config.json'), 'utf8'))).toMatchObject({ cliPluginsExtraDirs: ['/opt/homebrew/lib/docker/cli-plugins'] });

    env.out.length = 0;
    const before = env.runner.calls.length;
    expect(await env.run('apply', '--json')).toBe(0);
    const second = (ndjson(env.stdout()).at(-1) as { data: ApplyData }).data;
    expect(second.steps.filter((s) => s.status === 'changed').map((s) => s.id)).toEqual([]);
    expect(second.plan).toEqual([]);
    expect(env.runner.lines().slice(before).filter((l) => /^sudo/.test(l))).toEqual([]);
  });

  it('keeps pre-existing user content in settings.json, CLAUDE.md, .zshrc and .gitconfig', async () => {
    const { env } = await setup();
    await mkdir(join(env.home, '.claude'), { recursive: true });
    await writeFile(join(env.home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', env: { MINE: '1' } }));
    await writeFile(join(env.home, '.claude', 'CLAUDE.md'), '# My rules\n');
    await writeFile(join(env.home, '.gitconfig'), '[core]\n\teditor = vim\n');
    await writeFile(join(env.home, '.zshrc'), 'export KEEP=1\n');
    expect(await env.run('apply')).toBe(0);
    const settings = JSON.parse(await readFile(join(env.home, '.claude', 'settings.json'), 'utf8')) as { theme: string; env: Record<string, string> };
    expect(settings.theme).toBe('dark');
    expect(settings.env['MINE']).toBe('1');
    expect(await readFile(join(env.home, '.claude', 'CLAUDE.md'), 'utf8')).toMatch(/^# My rules\n/);
    expect(await readFile(join(env.home, '.gitconfig'), 'utf8')).toMatch(/^\[core\]\n\teditor = vim\n/);
    expect(await readFile(join(env.home, '.zshrc'), 'utf8')).toMatch(/^export KEEP=1\n/);
    const backups = (await readdir(join(env.home, '.claude'))).filter((f) => f.includes('.devhost-bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(2); // settings.json and CLAUDE.md
  });

  it('stops with a clear error when settings.json is not valid JSON, leaving it untouched', async () => {
    const { env } = await setup();
    await mkdir(join(env.home, '.claude'), { recursive: true });
    await writeFile(join(env.home, '.claude', 'settings.json'), '{ broken');
    expect(await env.run('apply', '--only', 'accounts.claude')).toBe(1);
    expect(env.err.join('')).toContain('not valid JSON');
    expect(await readFile(join(env.home, '.claude', 'settings.json'), 'utf8')).toBe('{ broken');
  });

  it('--dry-run lists the sudo launchd commands for Colima', async () => {
    const { env } = await setup();
    expect(await env.run('apply', '--dry-run', '--only', 'docker')).toBe(0);
    expect(env.stdout()).toContain('[sudo] docker.runtime: sudo install -m 644 -o root -g wheel');
    expect(env.stdout()).toContain('[sudo] docker.runtime: sudo launchctl bootstrap system');
  });
});
