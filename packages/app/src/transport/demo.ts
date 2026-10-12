import YAML from 'yaml';
import type { DashData } from '@devhost/contract/lite';
import type { RunResult, StreamHandle, TerminalRequest, Transport, TrayStatus } from './types';

/**
 * A made-up Mac mini for running the UI in a plain browser (vite dev, screenshots). It answers the
 * read commands with sample data and plays scripted event streams for the long ones.
 * Never used inside the app: there the Rust shell talks to the real host.
 */
export function createDemoTransport(host: string): Transport {
  let config = DEMO_CONFIG;
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

const DOCTOR = {
  ok: true,
  summary: { ok: 5, warn: 1, fail: 0 },
  checks: [
    { id: 'system.power', status: 'ok', message: 'never sleeps, restarts after power loss, wake on LAN' },
    { id: 'system.filevault', status: 'ok', message: 'FileVault is on: after a reboot the disk must be unlocked before anything starts' },
    { id: 'tools.docker', status: 'ok', message: 'Docker 27.3 (colima) is running' },
    { id: 'account.business.login', status: 'ok', message: 'logged in' },
    { id: 'env.acme-api.service', status: 'ok', message: 'Remote Control service running (pid 4242)' },
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
      'Only this Mac mini is covered: cloud sessions and sessions on other machines are not included.',
    ],
  };
}
