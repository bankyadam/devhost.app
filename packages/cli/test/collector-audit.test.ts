import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateConfig } from '@devhost/contract';
import { AlertEngine, type AlertInputs, type AlertThresholds } from '../src/collector/alerts.js';
import { Db } from '../src/collector/db.js';
import { Ingestor, moveSessionHistory } from '../src/collector/ingest.js';
import { buildRange } from '../src/collector/query.js';
import { pruneHandoffNotes, retain, rollup } from '../src/collector/rollup.js';
import { Collector, type OsProbe } from '../src/collector/run.js';
import { parseConfig } from '../src/config/load.js';
import { MockRunner } from '../src/runner/mock.js';
import type { Notification, Notifier } from '../src/collector/notify.js';

const H = 3_600_000;
const DAY = 24 * H;
const HOME = '/Users/op';
const CONFIG = parseConfig(
  `
machine: { hostname: macmini }
notify: { topic: devhost-abcdefgh }
accounts:
  - { name: business, default: true, root: ${HOME}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c }, alerts: { dailyCostUsd: 10 } }
environments:
  - { name: acme-api, account: business, portBase: 4100 }
`,
  '/c',
);
const T0 = new Date(2026, 9, 12, 12, 0, 0).getTime();

class Rec implements Notifier {
  readonly provider = 'test';
  sent: Notification[] = [];
  async send(n: Notification): Promise<void> {
    this.sent.push(n);
  }
}

const os: OsProbe = {
  platform: 'linux',
  cpus: () => [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }],
  loadavg: () => [1, 1, 1],
  totalmem: () => 1000,
  freemem: () => 600,
  uptime: () => 1,
  disk: async () => ({ freeBytes: 500, totalBytes: 1000 }),
};

function setup(runner: MockRunner, home = HOME) {
  const db = new Db(':memory:');
  const clock = { now: T0 };
  const notifier = new Rec();
  const collector = new Collector({ db, config: () => CONFIG, deps: { home, user: 'op', brewPrefix: '/opt/homebrew', runner }, notifier, now: () => clock.now, os });
  return { db, clock, notifier, collector };
}

describe('COL-6 late telemetry', () => {
  it('rolls an hour only after a 5 minute grace and re-rolls the last two hours', () => {
    const db = new Db(':memory:');
    const hour = Math.floor(T0 / H) * H;
    db.run("INSERT INTO usage VALUES (?, 'a', 'e', 's', 'm', 'output', 1)", hour - 1000);
    rollup(db, hour + 2 * 60_000); // within grace: the previous hour is not rolled yet
    expect(db.kvGet('rolled_through')).toBe(String(hour - H));
    rollup(db, hour + 6 * 60_000);
    expect(db.kvGet('rolled_through')).toBe(String(hour));
    expect(db.get('SELECT value FROM rollup_usage WHERE hour = ?', hour - H)).toMatchObject({ value: 1 });
    // A late row for the already rolled hour is picked up by the next run.
    db.run("INSERT INTO usage VALUES (?, 'a', 'e', 's', 'm', 'output', 2)", hour - 500);
    rollup(db, hour + 20 * 60_000);
    expect(db.get('SELECT value FROM rollup_usage WHERE hour = ?', hour - H)).toMatchObject({ value: 3 });
  });
});

describe('COL-9 sleep and wake', () => {
  it('a wake started during a sleep waits for it, and wakes exactly once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devhost-race-'));
    const project = 'devhost-acme-api';
    let stopping = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const runner = new MockRunner()
      .on('docker info', { stdout: '27\n' })
      .on('docker stats', { stdout: `{"Name":"${project}-api-1","CPUPerc":"1.00%","MemUsage":"1MiB / 8GiB"}\n` })
      .on('docker ps', { stdout: `${project}-api-1\t${project}\n` })
      .on(`docker compose -p ${project} ps`, { stdout: 'api running\n' })
      .on(/^docker compose -p \S+ (stop|start) /, {});
    const { collector, clock } = setup(runner, home);
    await collector.dockerTick();
    const orig = collector['exec'].exec.bind(collector['exec']);
    collector['exec'].exec = (async (...a: Parameters<typeof orig>) => {
      if (a[1].includes('stop')) {
        stopping = true;
        await gate;
      }
      return orig(...a);
    }) as typeof orig;
    clock.now += 2 * H;
    const sleeping = collector.sleepTick();
    await vi.waitFor(() => expect(stopping).toBe(true));
    const w1 = collector.wake({ account: 'business', env: 'acme-api', dir: `${HOME}/work/business/acme-api` });
    const w2 = collector.wake({ account: 'business', env: 'acme-api', dir: `${HOME}/work/business/acme-api` });
    release();
    await Promise.all([sleeping, w1, w2]);
    expect(runner.lines().filter((l) => l.endsWith('start api'))).toHaveLength(1);
    expect(runner.lines().filter((l) => l.endsWith('stop api'))).toHaveLength(1);
  });
});

describe('COL-13 and COL-21 alerts', () => {
  const thresholds = (cost: number | null): AlertThresholds => ({ memoryPercent: 90, diskFreePercent: 15, dailyCostUsd: new Map([['business', cost]]) });
  const input = (over: Partial<AlertInputs> = {}): AlertInputs => ({ memPct: null, diskFreePct: null, costToday: new Map([['business', 20]]), restarts: new Map(), auth: new Map(), ...over });

  it('clears an active alert whose condition is no longer evaluated', async () => {
    const db = new Db(':memory:');
    const e = new AlertEngine(db, new Rec(), () => T0);
    await e.evaluate(thresholds(10), input());
    expect(e.active().map((a) => a.id)).toEqual(['cost:business']);
    await e.evaluate(thresholds(null), input());
    expect(e.active()).toEqual([]);
  });

  it('disk alert clears only above the limit plus a margin', async () => {
    const db = new Db(':memory:');
    const n = new Rec();
    const e = new AlertEngine(db, n, () => T0);
    await e.evaluate(thresholds(null), input({ diskFreePct: 14 }));
    await e.evaluate(thresholds(null), input({ diskFreePct: 15.5 }));
    expect(e.active().map((a) => a.id)).toEqual(['disk']);
    await e.evaluate(thresholds(null), input({ diskFreePct: 18 }));
    expect(e.active()).toEqual([]);
    expect(n.sent).toHaveLength(2);
  });
});

describe('COL-12 authCheckMinutes', () => {
  it('schema rejects more than 1440', () => {
    const base = { machine: { hostname: 'm' }, notify: { topic: 'devhost-abcdefgh' } };
    expect(validateConfig({ ...base, collector: { authCheckMinutes: 1440 } }).ok).toBe(true);
    expect(validateConfig({ ...base, collector: { authCheckMinutes: 1441 } }).ok).toBe(false);
  });
});

describe('COL-16 retention of side data', () => {
  it('prunes kv families and old handoff notes', async () => {
    const db = new Db(':memory:');
    const now = T0 + 400 * DAY;
    const old = now - 40 * DAY;
    for (const k of ['handoff_failed:s1', 'awake:e1', 'auth_org:o', 'auth_email:x', 'auth_checked:gone', 'auth:gone', 'cum:k', 'email:a@b']) db.kvSet(k, '1', old);
    for (const k of ['handoff_failed:s2', 'awake:e2', 'auth_org:fresh', 'auth:live']) db.kvSet(k, '1', now - 1000);
    db.kvSet('rolled_through', String(Math.floor(now / H) * H), now);
    retain(db, now, { rawDays: 7, rollupDays: 365 });
    const keys = db.all<{ key: string }>('SELECT key FROM kv ORDER BY key').map((r) => r.key);
    expect(keys).toEqual(['auth:live', 'auth_org:fresh', 'awake:e2', 'email:a@b', 'handoff_failed:s2', 'rolled_through']);
    db.kvSet('email:a@b', 'x', now - 400 * DAY);
    retain(db, now, { rawDays: 7, rollupDays: 365 });
    expect(db.kvGet('email:a@b')).toBeNull();

    const home = await mkdtemp(join(tmpdir(), 'devhost-notes-'));
    const dir = join(home, '.local/share/devhost/handoff');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'old.md'), 'x');
    await writeFile(join(dir, 'new.md'), 'x');
    await utimes(join(dir, 'old.md'), new Date(now - 90 * DAY), new Date(now - 90 * DAY));
    await utimes(join(dir, 'new.md'), new Date(now), new Date(now));
    await pruneHandoffNotes(home, now, 7);
    expect(await readdir(dir)).toEqual(['new.md']);
  });
});

describe('COL-17 migrations', () => {
  it('migrates a shared file once and leaves the schema consistent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devhost-mig-'));
    const a = new Db(join(dir, 'x.db'));
    const b = new Db(join(dir, 'x.db'));
    expect(b.schemaVersion).toBe(a.schemaVersion);
    a.close();
    b.close();
  });
});

describe('COL-18 authProbe', () => {
  it('runs the probe with hooks disabled and no session persistence', async () => {
    const config = parseConfig(`machine: { hostname: m }\nnotify: { topic: devhost-abcdefgh }\ncollector: { authProbe: true }\naccounts:\n  - { name: a, default: true, root: ${HOME}/w, portRange: [3000, 3999], git: { name: A, email: a@b.c } }`, '/c');
    const runner = new MockRunner().on('sh -c command -v claude', { stdout: '/opt/homebrew/bin/claude\n' }).on('/opt/homebrew/bin/claude auth status', { code: 0 }).on('/opt/homebrew/bin/claude -p ok', { code: 0 });
    const db = new Db(':memory:');
    const c = new Collector({ db, config: () => config, deps: { home: HOME, user: 'op', brewPrefix: '/opt/homebrew', runner }, notifier: new Rec(), now: () => T0, os });
    await c.authTick();
    const probe = runner.calls.find((x) => x.args[0] === '-p')!;
    expect(probe.args).toEqual(expect.arrayContaining(['--no-session-persistence', '--settings', '{"disableAllHooks":true}']));
  });
});

describe('COL-11 overlaps are per source, not per command name', () => {
  it('two sources running different docker commands are no overlap', async () => {
    const { collector, db } = setup(new MockRunner());
    collector['procs'] = [
      { pid: process.pid + 1, ppid: process.pid, cpu: 0, rssKb: 0, command: 'docker stats --no-stream' },
      { pid: process.pid + 2, ppid: process.pid, cpu: 0, rssKb: 0, command: 'docker compose stop api' },
    ];
    collector.sampleSelf();
    expect(db.get('SELECT children, overlaps FROM samples_collector')).toMatchObject({ children: 2, overlaps: 0 });
  });
});

describe('COL-14 local midnight buckets', () => {
  it('buckets the 30d range at local midnight', () => {
    const prev = process.env['TZ'];
    process.env['TZ'] = 'Europe/Budapest';
    try {
      const db = new Db(':memory:');
      const now = new Date(2026, 9, 20, 12).getTime();
      const early = new Date(2026, 9, 12, 0, 30).getTime(); // 22:30 UTC the day before
      const late = new Date(2026, 9, 12, 23, 30).getTime();
      for (const ts of [early, late]) db.run("INSERT INTO usage VALUES (?, 'a', 'e', 's', 'm', 'output', 1)", ts);
      const mid = new Date(2026, 9, 12).getTime();
      const usage = buildRange(db, { range: '30d' }, now).usage;
      expect(usage.map((u) => [u.ts, u.output])).toEqual([[mid, 2]]);
      const week = buildRange(db, { range: '7d' }, new Date(2026, 9, 15, 12).getTime()).usage;
      expect(week.map((u) => u.ts)).toEqual([mid, new Date(2026, 9, 12, 18).getTime()]);
    } finally {
      if (prev === undefined) delete process.env['TZ'];
      else process.env['TZ'] = prev;
    }
  });
});

describe('COL-14 buckets across a DST change', () => {
  it('keeps one local-midnight alignment for the whole 30d range', () => {
    const prev = process.env['TZ'];
    process.env['TZ'] = 'Europe/Budapest';
    try {
      const db = new Db(':memory:');
      const now = new Date(2026, 10, 4, 12).getTime(); // CET; the range starts in CEST (clocks changed on 25 Oct)
      const before = new Date(2026, 9, 20, 10).getTime();
      const after = new Date(2026, 10, 3, 10).getTime();
      for (const ts of [before, after]) db.run("INSERT INTO usage VALUES (?, 'a', 'e', 's', 'm', 'output', 1)", ts);
      const usage = buildRange(db, { range: '30d' }, now).usage;
      // Every bucket starts at today's local midnight (23:00 UTC), so the 20 Oct one is 01:00 local (CEST) and matches the plugin's columns.
      expect(usage.map((u) => u.ts)).toEqual([new Date(2026, 9, 20).getTime() + 3_600_000, new Date(2026, 10, 3).getTime()]);
    } finally {
      if (prev === undefined) delete process.env['TZ'];
      else process.env['TZ'] = prev;
    }
  });
});

describe('COL-15 cold resume', () => {
  it('sees the previous request even outside the window or filtered out', () => {
    const db = new Db(':memory:');
    const now = T0;
    const ins = (ts: number, model: string, cc: number) =>
      db.run("INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source) VALUES (?, 'a', 'e', 's', ?, 10, 0, ?, 1, 'main')", ts, model, cc);
    ins(now - 5 * H, 'opus', 50_000); // long before the 1h range
    ins(now - 10 * 60_000, 'opus', 50_000); // cold resume
    const ctx = buildRange(db, { range: '1h' }, now).context;
    expect(ctx?.coldResumes).toBe(1);
    // Filtering by another model must not turn the previous request into a missing one.
    ins(now - 4 * H, 'haiku', 0);
    expect(buildRange(db, { range: '1h', model: 'opus' }, now).context?.coldResumes).toBe(1);
  });
});

describe('COL-21 moveSessionHistory moves every rollup', () => {
  it('moves the session rows of rollup_source and rollup_tools', () => {
    const db = new Db(':memory:');
    const hour = Math.floor(T0 / H) * H - 3 * H;
    db.run("INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source) VALUES (?, 'old', 'e', 's1', 'm', 5, 1, 0, 0, 0.5, 'main')", hour + 1000);
    db.run("INSERT INTO tool_runs VALUES (?, 'old', 'e', 's1', 'Bash', 100, 1)", hour + 2000);
    db.kvSet('rolled_through', String(hour + H), T0);
    db.run("INSERT INTO rollup_source VALUES (?, 'old', 'e', 'main', 'm', 1, 5, 1, 0, 0, 0.5)", hour);
    db.run("INSERT INTO rollup_tools VALUES (?, 'old', 'e', 'Bash', 1, 100)", hour);
    moveSessionHistory(db, 's1', 'new');
    expect(db.all('SELECT account, requests FROM rollup_source')).toEqual([{ account: 'new', requests: 1 }]);
    expect(db.all('SELECT account, runs FROM rollup_tools')).toEqual([{ account: 'new', runs: 1 }]);
  });
});

describe('COL-22 cumulative counters survive a restart', () => {
  it('does not count a cumulative total again after the collector restarts', () => {
    const db = new Db(':memory:');
    const body = (v: number) => ({
      resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { aggregationTemporality: 2, dataPoints: [{ asDouble: v, timeUnixNano: String(BigInt(T0) * 1_000_000n), attributes: [{ key: 'session.id', value: { stringValue: 's' } }] }] } }] }] }],
    });
    new Ingestor(db, () => T0, () => []).metrics(body(5));
    new Ingestor(db, () => T0, () => []).metrics(body(7)); // a new ingestor = a restart
    expect(db.get<{ v: number }>('SELECT SUM(value) AS v FROM usage')?.v).toBe(7);
  });
});
