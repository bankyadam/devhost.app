import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validate } from '@devhost/contract';
import type { DashData } from '@devhost/contract';
import { Db } from '../src/collector/db.js';
import type { Notification, Notifier } from '../src/collector/notify.js';
import { readDash } from '../src/collector/query.js';
import { Collector, type OsProbe } from '../src/collector/run.js';
import { Sources } from '../src/collector/sources.js';
import { parseConfig } from '../src/config/load.js';
import { MockRunner } from '../src/runner/mock.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { Executor } from '../src/runner/executor.js';
import { tailscaleStatus } from '../src/tailscale-status.js';

const HOME = '/Users/op';
const T0 = new Date(2026, 9, 12, 12, 0, 0).getTime();
const CONFIG = parseConfig(
  `
machine: { hostname: macmini }
notify: { topic: devhost-abcdefgh }
network: { tailscale: true }
docker: { runtime: colima }
accounts:
  - { name: business, default: true, root: ${HOME}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }
environments:
  - { name: acme-api, account: business, portBase: 4100 }
`,
  '/c',
);

class Quiet implements Notifier {
  readonly provider = 'test';
  async send(_n: Notification): Promise<void> {}
}

const os: OsProbe = {
  platform: 'darwin',
  cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }],
  loadavg: () => [1, 1, 1],
  totalmem: () => 1000,
  freemem: () => 600,
  uptime: () => 100,
  disk: async () => ({ freeBytes: 50, totalBytes: 100 }),
};

/**
 * Answers like the fake Mac, a little later (so runs can overlap), and records every command and
 * the most copies of each that ran at once.
 */
class SlowRunner implements Runner {
  readonly calls: string[] = [];
  readonly maxConcurrent = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  constructor(private readonly inner: MockRunner, private readonly delayMs = 2) {}
  async run(command: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push([command, ...args].join(' '));
    const n = (this.inFlight.get(command) ?? 0) + 1;
    this.inFlight.set(command, n);
    this.maxConcurrent.set(command, Math.max(this.maxConcurrent.get(command) ?? 0, n));
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      return await this.inner.run(command, args, opts);
    } finally {
      this.inFlight.set(command, (this.inFlight.get(command) ?? 1) - 1);
    }
  }
  spawn(): never {
    throw new Error('the collector never spawns interactive processes');
  }
}

function busyHost(): MockRunner {
  return new MockRunner()
    .on('launchctl print system/com.devhost.rc.business.acme-api', { stdout: 'state = running\n\tpid = 100\n' })
    .on('ps', { stdout: ' 100 1 2.0 10240 /opt/homebrew/bin/claude remote-control --name business-acme-api\n 101 100 8.0 20480 /opt/homebrew/bin/claude --print --session-id cse_01X\n' })
    .on('vm_stat', { stdout: 'Pages free: 10.\n' })
    .on('sysctl', { stdout: 'vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M\nkern.memorystatus_vm_pressure_level: 1\n' })
    .on('docker', { stdout: '' })
    .on('tailscale', { stdout: '{"BackendState":"Running","Self":{"DNSName":"macmini.ts.net."}}' })
    .on('claude', { stdout: '{"loggedIn":true}' })
    .on('du', { stdout: '1024\t/x\n' });
}

describe('collector load (spec A10.9)', () => {
  it('Sources: a tick that finds the previous run still going is skipped, and logged once', async () => {
    const log: string[] = [];
    const s = new Sources((m) => log.push(m));
    let release!: () => void;
    const first = s.run('docker', () => new Promise<void>((r) => (release = r)));
    let ran = 0;
    await s.run('docker', async () => void ran++);
    await s.run('docker', async () => void ran++);
    expect(ran).toBe(0);
    expect(s.skipped.get('docker')).toBe(2);
    expect(log).toEqual(['docker: the previous run is still going; skipping ticks until it ends']);
    release();
    await first;
    await s.run('docker', async () => void ran++);
    expect(ran).toBe(1);
    expect(log.at(-1)).toBe('docker: running again');
  });

  it('ten simulated minutes of every source, ticks firing faster than commands answer: no lsof, nothing runs twice at once', async () => {
    const runner = new SlowRunner(busyHost());
    const db = new Db(':memory:');
    const clock = { now: T0 };
    const collector = new Collector({ db, config: () => CONFIG, deps: { home: HOME, user: 'op', brewPrefix: '/opt/homebrew', runner }, notifier: new Quiet(), now: () => clock.now, os });
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: `${HOME}/work/business/acme-api/.claude/worktrees/bridge-cse_01X` }, 'business');
    const pending: Promise<void>[] = [];
    for (let s = 0; s < 600; s += 5) {
      clock.now = T0 + s * 1000;
      // Two timers firing for the same source before the first run is done.
      pending.push(collector.sampleTick(), collector.sampleTick());
      if (s % 15 === 0) pending.push(collector.dockerTick(), collector.dockerTick());
      if (s % 60 === 0) pending.push(collector.tailscaleTick(), collector.tailscaleTick());
      if (s === 0) pending.push(collector.authTick(), collector.diskUsageTick());
      if (s % 30 === 0) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);

    expect(runner.calls.filter((c) => c.startsWith('lsof'))).toEqual([]);
    for (const [command, n] of runner.maxConcurrent) expect({ command, n }).toEqual({ command, n: 1 });
    expect(collector.sources.skipped.get('sample')).toBeGreaterThan(0);
    // One ps per sample; launchd only once a minute while ps shows the service.
    const samples = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM samples_system')!.n;
    expect(runner.calls.filter((c) => c.startsWith('ps ')).length).toBe(samples);
    expect(runner.calls.filter((c) => c.startsWith('launchctl')).length).toBeLessThanOrEqual(11);
    expect(runner.calls.filter((c) => c.startsWith('tailscale')).length).toBe(10);
    expect(runner.calls.filter((c) => c.startsWith('tailscale')).every((c) => c === 'tailscale status --json --peers=false')).toBe(true);
    // The collector watched itself.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM samples_collector')!.n).toBe(samples);
    expect(db.get<{ o: number }>('SELECT SUM(overlaps) AS o FROM samples_collector')!.o).toBe(0);
  });

  it('every tick writes the dashboard snapshot; dash and the plugins read it instead of computing', async () => {
    const runner = new SlowRunner(busyHost(), 0);
    const db = new Db(':memory:');
    const clock = { now: T0 };
    const collector = new Collector({ db, config: () => CONFIG, deps: { home: HOME, user: 'op', brewPrefix: '/opt/homebrew', runner }, notifier: new Quiet(), now: () => clock.now, os });
    await collector.sampleTick();
    await collector.tailscaleTick();
    clock.now += 5000;
    await collector.sampleTick();
    const snap = JSON.parse(db.kvGet('snapshot')!) as DashData;
    expect(validate('result.dash', snap).ok).toBe(true);
    expect(snap).toMatchObject({ generatedAt: T0 + 5000, range: '24h', host: { online: true, tailscale: { state: 'Running', dnsName: 'macmini.ts.net' } } });

    // Read a little later: the collector's snapshot as it is (no recompute) for its range…
    expect(readDash(db, CONFIG, { range: '24h' }, T0 + 6000, 'x', null).generatedAt).toBe(T0 + 5000);
    // …the range parts for another range, and a stopped collector's snapshot says offline.
    expect(readDash(db, CONFIG, { range: '7d' }, T0 + 6000, 'x', null)).toMatchObject({ generatedAt: T0 + 5000, range: '7d' });
    expect(readDash(db, CONFIG, { range: '24h' }, T0 + 10 * 60_000, 'x', null).host.online).toBe(false);
  });
});

describe('tailscale status', () => {
  let dir = '';
  afterEach(async () => {
    delete process.env['DEVHOST_TAILSCALE_SOCKET'];
    process.env['DEVHOST_TAILSCALE_SOCKET'] = '/nonexistent/tailscaled.socket';
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('asks tailscaled on its unix socket (LocalAPI, no peers), with no child process', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ts-'));
    const socket = join(dir, 'tailscaled.socket');
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(`${req.headers.host} ${req.url}`);
      res.end(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'macmini.ts.net.', TailscaleIPs: ['100.1.2.3'] } }));
    });
    await new Promise<void>((r) => server.listen(socket, r));
    process.env['DEVHOST_TAILSCALE_SOCKET'] = socket;
    const runner = new MockRunner();
    const exec = new Executor(runner, { step: () => undefined, log: () => undefined }, { dryRun: false, verbose: false, interactiveSudo: false, now: () => new Date() });
    try {
      expect(await tailscaleStatus(exec)).toEqual({ BackendState: 'Running', Self: { DNSName: 'macmini.ts.net.', TailscaleIPs: ['100.1.2.3'] } });
      expect(paths).toEqual(['local-tailscaled.sock /localapi/v0/status?peers=false']);
      expect(runner.calls).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
