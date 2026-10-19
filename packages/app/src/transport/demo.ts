import YAML from 'yaml';
import type { DashData } from '@devhost/contract/lite';
import { agentBuckets, buildBuckets, TOKEN_TYPES, type Metric, type Stack } from '../lib/usage';
import type { RunResult, StreamHandle, TerminalRequest, Transport, TrayStatus } from './types';

/**
 * A made-up host for running the UI in a plain browser (vite dev, screenshots). It answers the
 * read commands with sample data and plays scripted event streams for the long ones.
 * Never used inside the app: there the Rust shell talks to the real host.
 */
export function createDemoTransport(host: string): Transport {
  let config = DEMO_CONFIG;
  const demoWebApps = new Set<string>();
  const now = Date.now();

  const envelope = (data: unknown, ok = true, errors: unknown[] = []): RunResult => ({ code: ok ? 0 : 2, stdout: `${JSON.stringify({ contractVersion: 1, ok, data, errors })}\n`, stderr: '' });

  const run: Transport['run'] = async (args, opts) => {
    const [a, b] = args;
    if (a === 'version') return envelope({ cliVersion: '0.1.0', contractVersion: 1 });
    if (a === 'dash') return envelope(demoDash(Date.now(), args[args.indexOf('--range') + 1] as DashData['range']));
    if (a === 'account' && b === 'list') return envelope({ accounts: ACCOUNTS });
    if (a === 'env' && b === 'list') return envelope({ environments: ENVS });
    if ((a === 'env' || a === 'collector') && b === 'logs') return envelope({ name: args[2] ?? 'collector', path: '/Users/me/Library/Logs/devhost/x.log', lines: LOG });
    if (a === 'doctor') return envelope(DOCTOR);
    if (a === 'plugin' && b === 'list') return envelope({ plugins: DEMO_PLUGINS });
    if (a === 'storage' && b === 'status') return envelope({ configured: true, volume: { label: 'devwork', uuid: '6F1C2A44-9B3E-4C5D-8E7F-0123456789AB', mountPoint: '/Volumes/devwork', root: '/Volumes/devwork/work', mounted: true, uuidMatch: true, markerMatch: true, ready: true, doubleMount: false, strayDirectory: false, apfs: true, encrypted: true, locked: false, ownership: true, totalBytes: 2e12, freeBytes: 1.42e12, encryptedInConfig: true, spotlightOff: true, automountWithoutLogin: true, unlockDaemon: true, passphraseStored: true } });
    if (a === 'storage' && b === 'list') return envelope({ disks: [{ device: 'disk4', model: 'Samsung T9', sizeBytes: 2e12, volumes: [{ device: 'disk5s1', name: 'devwork', uuid: '6F1C2A44-9B3E-4C5D-8E7F-0123456789AB', mountPoint: '/Volumes/devwork', sizeBytes: 2e12, adopted: true }] }] });
    if (a === 'plugin' && b === 'widgets') {
      const param = (k: string): string | undefined => args.find((x) => x.startsWith(`stats.${k}=`))?.slice(k.length + 7);
      return envelope(demoStats(demoDash(Date.now(), (param('range') || '24h') as DashData['range']), param('metric') === 'cost' ? 'cost' : 'tokens', param('stack') === 'type' ? 'type' : 'account', DEMO_WIDGETS));
    }
    if (a === 'config' && b === 'raw') return envelope({ path: '~/.config/devhost/config.yaml', text: config });
    if (a === 'config' && b === 'get') return envelope({ pointer: '', value: YAML.parse(config) });
    if (a === 'config' && b === 'validate') {
      try {
        const v = YAML.parse(opts?.stdin ?? '') as { machine?: { hostname?: string } };
        const hostname = v?.machine?.hostname ?? '';
        if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(hostname)) return envelope(null, false, [{ code: 'config-invalid', message: '/machine/hostname: does not match the required pattern', path: '/machine/hostname' }]);
        return envelope({ valid: true, path: '<stdin>' });
      } catch (e) {
        return envelope(null, false, [{ code: 'config-invalid', message: `not valid YAML: ${(e as Error).message}` }]);
      }
    }
    if (a === 'config' && b === 'put') {
      config = opts?.stdin ?? config;
      return envelope({ pointer: '', value: null, path: '~/.config/devhost/config.yaml', backup: null });
    }
    return envelope(null, false, [{ code: 'demo', message: 'this is the demo host: nothing is executed' }]);
  };

  const stream: Transport['stream'] = (args, onLine) => {
    let stopped = false;
    let resolve!: (c: number) => void;
    const done = new Promise<number>((r) => (resolve = r));
    const emit = (o: object): void => { if (!stopped) onLine(JSON.stringify(o)); };
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const finish = (code: number): void => { stopped = true; resolve(code); };

    void (async () => {
      const [a, b] = args;
      if (a === 'dash') {
        const range = args[args.indexOf('--range') + 1] as DashData['range'];
        while (!stopped) {
          emit({ type: 'snapshot', data: demoDash(Date.now(), range) });
          await wait(2000);
        }
        return;
      }
      const steps = a === 'apply' ? ['system.power', 'packages', 'docker.runtime', 'collector', 'env.acme-api'] : ['config', 'accounts.claude', 'env.demo'];
      for (const id of steps) {
        emit({ type: 'step', id, status: 'start' });
        await wait(250);
        emit({ type: 'step', id, status: a === 'apply' && args.includes('--dry-run') && id === 'packages' ? 'changed' : 'ok', ...(id === 'packages' ? { message: 'would change: a package is missing' } : {}) });
      }
      if (a === 'login' || (a === 'account' && b === 'add')) emit({ type: 'prompt', id: 'auth-code', kind: 'open-url', url: 'https://claude.ai/oauth/authorize?demo=1', message: 'Open this URL on any device, sign in and paste the code.' });
      await wait(300);
      const plan = args.includes('--dry-run') ? [{ stepId: 'packages', action: 'brew bundle --file=~/.config/devhost/Brewfile', sudo: false }, { stepId: 'docker.runtime', action: 'sudo launchctl bootstrap system /Library/LaunchDaemons/com.devhost.colima.plist', sudo: true, reason: 'start com.devhost.colima' }] : [];
      emit({ type: 'result', ok: true, data: { dryRun: args.includes('--dry-run'), changed: plan.length > 0, steps: [], plan, name: 'demo', loggedIn: true, restarted: [] } });
      finish(0);
    })();

    return { write: () => undefined, cancel: () => finish(130), done } satisfies StreamHandle;
  };

  return {
    host,
    run,
    stream,
    openUrl: async (url) => void window.open(url, '_blank', 'noopener'),
    openTerminal: async (r: TerminalRequest) => void console.info('[demo] open Terminal', r),
    openVscode: async (p) => void console.info('[demo] open VS Code', p),
    detectTools: async () => ({ code: true, iterm: false }),
    listWebApps: async () => [...demoWebApps].sort(),
    setupWebApp: async (account) => {
      demoWebApps.add(`Claude – ${account}`);
      return `~/Library/Application Support/app.devhost.desktop/web-app-icons/Claude – ${account}.png`;
    },
    openWebApp: async (name, url) => void console.info('[demo] open web app', name, url ?? ''),
    setTray: async (s: TrayStatus, n: number) => void console.info('[demo] tray', s, n),
    onNavigate: () => () => undefined,
  };

  // `now` keeps the fixtures' relative times stable within one page load.
  void now;
}

const DEMO_CONFIG = `# devhost configuration (demo)
machine:
  hostname: macmini
  power: { neverSleep: true, autoRestartAfterPowerLoss: true, wakeOnLan: true }
accounts:
  - { name: personal, default: true, configDir: null, root: ~/work/personal, portRange: [3000, 3999], git: { name: Ada, email: ada@example.com } }
  - { name: business, configDir: ~/.claude-business, root: ~/work/business, portRange: [4000, 4999], git: { name: Ada, email: ada@work.example }, alerts: { dailyCostUsd: 50 } }
environments:
  - { name: acme-api, account: business, portBase: 4100 }
  - { name: blog, account: personal, portBase: 3000 }
packages:
  brew: [git, gh, tmux, mosh, direnv, jq, ripgrep, mise]
runtimes: { node: lts, python: "3.12" }
docker: { runtime: colima, cpu: 6, memoryGiB: 16, diskGiB: 200 }
network: { tailscale: true, ssh: true }
notify: { provider: ntfy, topic: "devhost-demo-topic" }
`;

const ACCOUNTS = [
  { name: 'personal', default: true, configDir: null, root: '~/work/personal', portRange: [3000, 3999], loggedIn: true, environments: 1 },
  { name: 'business', default: false, configDir: '~/.claude-business', root: '~/work/business', portRange: [4000, 4999], loggedIn: true, environments: 1 },
];

const ENVS = [
  { name: 'acme-api', account: 'business', dir: '/Users/me/work/business/acme-api', dirExists: true, portBase: 4100, remoteControl: { enabled: true, spawn: 'worktree', permissionMode: 'acceptEdits' }, compose: 'auto', service: { label: 'com.devhost.rc.business.acme-api', state: 'running', pid: 4242 } },
  { name: 'blog', account: 'personal', dir: '/Users/me/work/personal/blog', dirExists: true, portBase: 3000, remoteControl: { enabled: true, spawn: 'worktree', permissionMode: 'acceptEdits' }, compose: 'off', service: { label: 'com.devhost.rc.personal.blog', state: 'running', pid: 4301 } },
];

const LOG = ['2026-10-12T09:01:12Z Remote Control server started', '2026-10-12T09:01:13Z Session URL: https://claude.ai/code/…', '2026-10-12T11:40:02Z connection re-established'];

const DEMO_PLUGINS = [
  { name: 'disk-cleanup', version: '1.1.0', description: 'Free disk space: package caches and old Remote Control worktrees', builtin: false, enabled: true, source: '~/.config/devhost/plugins/disk-cleanup/index.js', actions: [{ id: 'clean', title: 'Free disk space', description: 'Empty the Homebrew and npm caches and remove old worktrees that are clean and pushed', scope: 'host', destructive: true }], checks: ['reclaimable'] },
];

const DEMO_WIDGETS = [
  {
    plugin: 'disk-cleanup', id: 'reclaimable', title: 'Disk cleanup', status: 'warn', summary: '6.2 GB reclaimable', action: 'clean',
    tiles: [{ label: 'Homebrew cache', value: '3.1 GB' }, { label: 'npm cache', value: '1.4 GB' }, { label: 'Old worktrees', value: '1.7 GB', sub: '4 of 7' }],
  },
];

const DOCTOR = {
  ok: true,
  summary: { ok: 5, warn: 2, fail: 0 },
  checks: [
    { id: 'system.power', status: 'ok', message: 'never sleeps, restarts after power loss, wake on LAN' },
    { id: 'system.filevault', status: 'ok', message: 'FileVault is on: after a reboot the disk must be unlocked before anything starts' },
    { id: 'tools.docker', status: 'ok', message: 'Docker 27.3 (colima) is running' },
    { id: 'account.business.login', status: 'ok', message: 'logged in' },
    { id: 'env.acme-api.service', status: 'ok', message: 'Remote Control service running (pid 4242)' },
    { id: 'system.disk', status: 'warn', message: 'only 12% of the disk is free (alert limit 15%)', fix: 'Free space: docker system prune, remove old worktrees and node_modules.', advice: [{ plugin: 'disk-cleanup', message: '6.2 GB reclaimable: Homebrew cache 3.1 GB, npm cache 1.4 GB, 4 old worktree(s) 1.7 GB', fix: 'devhost plugin run disk-cleanup clean', action: 'clean' }] },
    { id: 'collector.data', status: 'warn', message: 'no telemetry received in the last hour (fine if no session was used)', fix: 'Start a session; check ~/.claude*/settings.json has the OTEL_* env keys.' },
  ],
};

function demoDash(at: number, range: DashData['range']): DashData {
  const size = { '1h': 5 * 60_000, '24h': 3_600_000, '7d': 6 * 3_600_000, '30d': 86_400_000 }[range];
  const span = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[range];
  const end = Math.floor(at / size) * size;
  const usage: DashData['usage'] = [];
  for (let t = end - span + size, i = 0; t <= end; t += size, i++) {
    for (const [account, k] of [['personal', 1], ['business', 2.4]] as const) {
      const wave = Math.max(0, Math.sin(i / 3 + k) + 0.4) * ((i * 7 + k * 13) % 5 === 0 ? 0.2 : 1);
      if (wave < 0.15) continue;
      usage.push({ ts: t, account, input: Math.round(40_000 * wave * k), output: Math.round(9_000 * wave * k), cacheRead: Math.round(300_000 * wave * k), cacheCreation: Math.round(22_000 * wave * k), costUsd: +(0.35 * wave * k).toFixed(3) });
    }
  }
  return {
    generatedAt: at,
    range,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    host: { name: 'macmini', online: true, uptimeSeconds: 9 * 86400 + 4 * 3600, cpuPercent: 18.4, memPercent: 46, memTotalBytes: 64 * 1024 ** 3, diskFreePercent: 61, diskFreeBytes: 1.2e12, docker: 'up', tailscale: { state: 'Running', dnsName: 'macmini.tail1234.ts.net' } },
    collector: { lastSampleAt: at - 1500, lastOtelAt: at - 20_000, lastHookAt: at - 8_000, dbSizeBytes: 18_400_000, schemaVersion: 1 },
    alerts: [],
    accounts: [
      { name: 'personal', loggedIn: true, lastAuthCheckAt: at - 600_000, today: { tokens: 1_240_000, costUsd: 3.8 }, week: { tokens: 7_900_000, costUsd: 21.4 }, dailyCostAlertUsd: null },
      { name: 'business', loggedIn: true, lastAuthCheckAt: at - 600_000, today: { tokens: 4_820_000, costUsd: 41.2 }, week: { tokens: 23_100_000, costUsd: 188.6 }, dailyCostAlertUsd: 50 },
    ],
    environments: [
      { account: 'business', name: 'acme-api', service: { state: 'running', pid: 4242 }, cpuPercent: 12.5, rssBytes: 1.4e9, containerCpuPercent: 3.2, containerMemBytes: 8.2e8, portBase: 4100, diskBytes: 3.1e9, activeSessions: 2 },
      { account: 'personal', name: 'blog', service: { state: 'running', pid: 4301 }, cpuPercent: 0.4, rssBytes: 2.6e8, containerCpuPercent: null, containerMemBytes: null, portBase: 3000, diskBytes: 6.4e8, activeSessions: 1 },
    ],
    sessions: [
      { id: '7c5dcf5d-aaaa', account: 'business', env: 'acme-api', state: 'waiting', startedAt: at - 3 * 3_600_000, lastActivityAt: at - 95_000, tokensToday: 2_100_000, costToday: 18.7, cpuPercent: 2.1, rssBytes: 4.8e8 },
      { id: '19be2a40-bbbb', account: 'business', env: 'acme-api', state: 'running', startedAt: at - 40 * 60_000, lastActivityAt: at - 4_000, tokensToday: 640_000, costToday: 5.9, cpuPercent: 38.5, rssBytes: 7.1e8 },
      { id: 'd02e8c11-cccc', account: 'personal', env: 'blog', state: 'idle', startedAt: at - 5 * 3_600_000, lastActivityAt: at - 25 * 60_000, tokensToday: 310_000, costToday: 1.2, cpuPercent: null, rssBytes: null },
      { id: 'a4417f90-dddd', account: 'business', env: null, state: 'ended', startedAt: at - 9 * 3_600_000, lastActivityAt: at - 7 * 3_600_000, tokensToday: 120_000, costToday: 0.9, cpuPercent: null, rssBytes: null },
    ],
    usage,
    limits: [
      'Cost is an estimate reported by Claude Code. On a subscription it is API-equivalent value, not billed money.',
      'Subscription plan limits (session and weekly usage) are not part of the telemetry and are not shown.',
      'CPU and memory per session is best effort; per-environment numbers are reliable.',
      'Only this host is covered: cloud sessions and sessions on other machines are not included.',
    ],
  };
}

/** What the built-in stats plugin would answer, from the demo dashboard data. */
function demoStats(d: DashData, metric: Metric, stack: Stack, others: unknown[]) {
  const usd = (v: number): string => `$${v.toFixed(2)}`;
  const seg = (id: string, label: string, value: string, options: [string, string][]) => ({ plugin: 'stats', id, label, kind: 'segmented', value, options: options.map(([v, l]) => ({ value: v, label: l })) });
  const byType = stack === 'type' && metric === 'tokens';
  return {
    filters: [
      seg('range', 'Time range', d.range, [['1h', 'Last hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']]),
      { plugin: 'stats', id: 'account', label: 'Account', kind: 'select', allLabel: 'All accounts', value: '', options: d.accounts.map((x) => ({ value: x.name, label: x.name })) },
      { plugin: 'stats', id: 'model', label: 'Model', kind: 'select', allLabel: 'All models', value: '', options: d.models.map((m) => ({ value: m, label: m })) },
      seg('metric', 'Metric', metric, [['tokens', 'Tokens'], ['cost', 'Cost']]),
      seg('stack', 'Stack by', byType ? 'type' : 'account', [['account', 'Account'], ['type', 'Token type']]),
    ],
    widgets: [
      ...d.accounts.map((x) => ({
        plugin: 'stats', id: `accounts:${x.name}`, title: x.name, account: x.name, refreshSeconds: 15, status: 'ok', summary: 'logged in',
        tiles: [{ label: 'Today', value: String(x.today.tokens), sub: `tokens · ~${usd(x.today.costUsd)}` }, { label: 'This week', value: String(x.week.tokens), sub: `tokens · ~${usd(x.week.costUsd)}` }],
        ...(x.dailyCostAlertUsd != null ? { meter: { label: `Daily cost alert at ${usd(x.dailyCostAlertUsd)} (estimate)`, value: x.today.costUsd, max: x.dailyCostAlertUsd } } : {}),
      })),
      {
        plugin: 'stats', id: 'usage', title: 'Usage over time', size: 'wide', refreshSeconds: 15,
        chart: {
          title: metric === 'tokens' ? 'Tokens over time' : 'Estimated cost over time',
          series: byType ? TOKEN_TYPES.map((t) => ({ key: t.key, label: t.label })) : d.accounts.map((x) => ({ key: x.name, label: x.name })),
          ...(byType ? {} : { colorBy: 'account' }),
          points: buildBuckets(d, metric, byType ? 'type' : 'account', d.accounts.map((x) => x.name)),
          axis: d.range === '1h' || d.range === '24h' ? 'time' : 'date', format: metric === 'cost' ? 'usd' : 'compact',
        },
      },
      { plugin: 'stats', id: 'agents', title: 'Agents at work', size: 'wide', refreshSeconds: 15, summary: `now ${d.agents?.now.sessions ?? 0} sessions + ${d.agents?.now.subagents ?? 0} subagents`, chart: { title: 'Most agents at once', series: [{ key: 'total', label: 'Agents' }], points: agentBuckets(d), axis: 'time', format: 'integer', height: 140 } },
      ...others,
    ],
  };
}
