import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validate } from '@devhost/contract';
import type { DashData, Envelope } from '@devhost/contract';
import { AlertEngine } from '../src/collector/alerts.js';
import { Db, dbPath } from '../src/collector/db.js';
import { envLocations, parseHook } from '../src/collector/hooks.js';
import { Ingestor } from '../src/collector/ingest.js';
import { createNotifier, maskTopic, NtfyNotifier, type Notification, type Notifier } from '../src/collector/notify.js';
import { CumulativeTracker, parseLogs, parseMetrics, parseToolRuns, sourceOf } from '../src/collector/otlp.js';
import { buildDash, buildRange, envCosts } from '../src/collector/query.js';
import { buildProfile, merge, subtract, toolClass, total } from '../src/collector/profile.js';
import type { PluginContext, WidgetContent } from '../src/plugins/api.js';
import { retain, rollup } from '../src/collector/rollup.js';
import { Collector, type OsProbe } from '../src/collector/run.js';
import { cpuPercent, memoryFromVmStat, parseMemorySysctl, parseDockerPs, parseDockerStats, parseDu, parseLsofCwd, parsePs, parseSize, parseVmStat, subtree, sumProcs } from '../src/collector/samplers.js';
import { createCollectorServer, listen } from '../src/collector/server.js';
import { projectSlug, sessionTitle } from '../src/collector/titles.js';
import { renderTop } from '../src/collector/top.js';
import { parseConfig } from '../src/config/load.js';
import { collectorToken, tokenPath } from '../src/collector/token.js';
import { collectorSpec } from '../src/steps/collector.js';
import type { StepContext } from '../src/steps/types.js';
import { stat } from 'node:fs/promises';
import { MockRunner } from '../src/runner/mock.js';
import { sleepState } from '../src/sleep.js';
import { fakeMac, makeEnv, ndjson } from './helpers.js';

const HOME = '/Users/op';
const CONFIG = parseConfig(
  `
machine: { hostname: macmini }
notify: { topic: devhost-abcdefgh }
accounts:
  - { name: personal, default: true, root: ${HOME}/work/personal, portRange: [3000, 3999], git: { name: A, email: a@b.c } }
  - { name: business, configDir: ${HOME}/.claude-business, root: ${HOME}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c }, alerts: { dailyCostUsd: 10 } }
environments:
  - { name: acme-api, account: business, portBase: 4100, alerts: { dailyCostUsd: 5, hourlyCostUsd: 2 } }
`,
  '/c',
);

const H = 3_600_000;
const T0 = new Date(2026, 9, 12, 12, 0, 0).getTime(); // local noon

const kv = (key: string, value: string | number) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
const metricsBody = (opts: { account?: string; env?: string; email?: string; temporality?: number; points: { name: string; value: number; attrs?: Record<string, string> }[] }) => ({
  resourceMetrics: [
    {
      resource: { attributes: [...(opts.account ? [kv('devhost.account', opts.account)] : []), ...(opts.env ? [kv('devhost.env', opts.env)] : [])] },
      scopeMetrics: [
        {
          metrics: opts.points.map((p) => ({
            name: p.name,
            sum: {
              aggregationTemporality: opts.temporality ?? 1,
              dataPoints: [{ asDouble: p.value, timeUnixNano: String(BigInt(T0) * 1_000_000n), attributes: [...Object.entries(p.attrs ?? {}).map(([k, v]) => kv(k, v)), ...(opts.email ? [kv('user.email', opts.email)] : [])] }],
            },
          })),
        },
      ],
    },
  ],
});

const attribution = () => {
  const map = new Map<string, string>();
  return { emailToAccount: (e: string) => map.get(e), learn: (e: string, a: string) => void map.set(e, a) };
};

describe('db', () => {
  it('migrates once and keeps the version', () => {
    const db = new Db(':memory:');
    expect(db.schemaVersion).toBe(8);
    db.kvSet('a', '1', 5);
    expect(db.kvGet('a')).toBe('1');
    expect(db.kvGet('missing')).toBeNull();
    db.close();
  });
});

describe('OTLP parsing', () => {
  it('maps Claude Code metrics to usage rows with devhost attribution', () => {
    const rows = parseMetrics(
      metricsBody({
        account: 'business',
        env: 'acme-api',
        points: [
          { name: 'claude_code.token.usage', value: 120, attrs: { type: 'input', model: 'm1', 'session.id': 's1' } },
          { name: 'claude_code.token.usage', value: 30, attrs: { type: 'cacheRead', model: 'm1', 'session.id': 's1' } },
          { name: 'claude_code.cost.usage', value: 0.5, attrs: { model: 'm1', 'session.id': 's1' } },
          { name: 'claude_code.lines_of_code.count', value: 7, attrs: { type: 'removed' } },
          { name: 'claude_code.session.count', value: 1 },
          { name: 'claude_code.something_else', value: 9 },
        ],
      }),
      T0,
      new CumulativeTracker(),
      attribution(),
    );
    expect(rows.map((r) => [r.kind, r.value, r.account, r.env, r.sessionId, r.model])).toEqual([
      ['input', 120, 'business', 'acme-api', 's1', 'm1'],
      ['cacheRead', 30, 'business', 'acme-api', 's1', 'm1'],
      ['cost', 0.5, 'business', 'acme-api', 's1', 'm1'],
      ['lines_removed', 7, 'business', 'acme-api', '', ''],
      ['sessions', 1, 'business', 'acme-api', '', ''],
    ]);
    expect(rows[0]!.ts).toBe(T0);
  });

  it('turns cumulative counters into deltas', () => {
    const tracker = new CumulativeTracker();
    const body = (v: number) => metricsBody({ account: 'a', temporality: 2, points: [{ name: 'claude_code.cost.usage', value: v, attrs: { model: 'm' } }] });
    const values = [1, 3, 3.5, 0.5].map((v) => parseMetrics(body(v), T0, tracker, attribution())[0]?.value);
    expect(values).toEqual([1, 2, 0.5, 0.5]); // the last one is a counter reset
  });

  it('falls back to user.email → account learned from earlier datapoints', () => {
    const attr = attribution();
    parseMetrics(metricsBody({ account: 'business', email: 'me@work.example', points: [{ name: 'claude_code.cost.usage', value: 1 }] }), T0, new CumulativeTracker(), attr);
    const rows = parseMetrics(metricsBody({ email: 'me@work.example', points: [{ name: 'claude_code.cost.usage', value: 2 }] }), T0, new CumulativeTracker(), attr);
    expect(rows[0]).toMatchObject({ account: 'business', env: '' });
  });

  it("the login's organization decides the account, over devhost.account from the config directory", () => {
    const claimed: [string, string][] = [];
    const attr = { ...attribution(), ownerOf: (org: string) => (org === 'org-work' ? 'business' : undefined), claim: (s: string, a: string) => void claimed.push([s, a]) };
    // The Claude app's Claude Code reads ~/.claude (personal's) while signed in to the work org.
    const rows = parseMetrics(metricsBody({ account: 'personal', email: 'me@work.example', points: [{ name: 'claude_code.cost.usage', value: 1, attrs: { 'organization.id': 'org-work', 'session.id': 's9' } }] }), T0, new CumulativeTracker(), attr);
    expect(rows[0]).toMatchObject({ account: 'business', sessionId: 's9' });
    expect(claimed).toEqual([['s9', 'business']]);
    // Unknown organization: devhost.account as before.
    const other = parseMetrics(metricsBody({ account: 'personal', points: [{ name: 'claude_code.cost.usage', value: 1, attrs: { 'organization.id': 'org-x' } }] }), T0, new CumulativeTracker(), attr);
    expect(other[0]).toMatchObject({ account: 'personal' });
  });

  it('keeps only api_request events from logs and never reads prompt text', () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [kv('devhost.account', 'business')] },
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: String(BigInt(T0) * 1_000_000n), attributes: [kv('event.name', 'api_request'), kv('model', 'm1'), kv('input_tokens', 10), kv('output_tokens', 5), kv('cost_usd', 0.02), kv('duration_ms', 900), kv('session.id', 's1')] },
                { attributes: [kv('event.name', 'user_prompt'), kv('prompt', 'TOP SECRET PROMPT'), kv('session.id', 's1')] },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseLogs(body, T0, attribution());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account: 'business', sessionId: 's1', input: 10, output: 5, costUsd: 0.02, durationMs: 900 });
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });
});

describe('hooks', () => {
  it('whitelists event, session id and cwd', () => {
    expect(parseHook({ hook_event_name: 'Stop', session_id: 's', cwd: '/x', last_assistant_message: 'SECRET', prompt: 'SECRET' })).toEqual({ event: 'Stop', sessionId: 's', cwd: '/x' });
    expect(parseHook({ hook_event_name: 'PreToolUse', session_id: 's' })).toBeNull();
    expect(parseHook({ hook_event_name: 'Stop' })).toBeNull();
    expect(parseHook('nope')).toBeNull();
  });

  it('tracks session state and attributes sessions to environments by cwd (also worktrees)', () => {
    const db = new Db(':memory:');
    let now = T0;
    const ingest = new Ingestor(db, () => now, () => envLocations(CONFIG, HOME));
    const cwd = `${HOME}/work/business/acme-api/.claude/worktrees/feature-x`;
    for (const [event, state] of [['SessionStart', 'idle'], ['UserPromptSubmit', 'running'], ['Notification', 'waiting'], ['Stop', 'idle'], ['SessionEnd', 'ended']] as const) {
      now += 1000;
      expect(ingest.hook({ hook_event_name: event, session_id: 's1', cwd, notification_type: 'permission_prompt' }, '')).toBe(true);
      expect(db.get<{ state: string }>('SELECT state FROM sessions WHERE session_id = ?', 's1')?.state).toBe(state);
    }
    expect(db.get('SELECT account, env, ended_at FROM sessions')).toMatchObject({ account: 'business', env: 'acme-api', ended_at: T0 + 5000 });
    // A session outside any environment keeps the account from the URL and env ''.
    ingest.hook({ hook_event_name: 'SessionStart', session_id: 's2', cwd: '/tmp/elsewhere' }, 'personal');
    expect(db.get("SELECT account, env FROM sessions WHERE session_id = 's2'")).toMatchObject({ account: 'personal', env: '' });
  });

  it("a session's telemetry from a known login moves it to that account, and later hooks keep it there", () => {
    const db = new Db(':memory:');
    const ingest = new Ingestor(db, () => T0, () => envLocations(CONFIG, HOME));
    db.kvSet('auth_org:org-work', 'business', T0);
    // The Claude app's session: ~/.claude's hook says personal, the directory is no environment.
    ingest.hook({ hook_event_name: 'SessionStart', session_id: 's3', cwd: '/Users/me/Documents/x' }, 'personal');
    db.run("INSERT INTO usage VALUES (?, 'personal', '', 's3', 'm', 'cost', 0.5)", T0 - H);
    db.run("INSERT INTO rollup_usage VALUES (?, 'personal', '', 's3', 'm', 'cost', 0.25)", T0 - 2 * H);
    db.run("INSERT INTO rollup_usage VALUES (?, '', '', 's3', 'm', 'cost', 0.5)", T0 - 2 * H);
    db.run("INSERT INTO rollup_usage VALUES (?, 'business', '', 's3', 'm', 'cost', 1)", T0 - 2 * H);
    ingest.metrics(metricsBody({ account: 'personal', points: [{ name: 'claude_code.cost.usage', value: 1, attrs: { 'organization.id': 'org-work', 'session.id': 's3' } }] }));
    expect(db.get("SELECT account FROM sessions WHERE session_id = 's3'")).toMatchObject({ account: 'business' });
    // Its history moves too.
    expect(db.all("SELECT DISTINCT account FROM usage WHERE session_id = 's3'")).toEqual([{ account: 'business' }]);
    expect(db.all("SELECT account, value FROM rollup_usage WHERE session_id = 's3'")).toEqual([{ account: 'business', value: 1.75 }]);
    expect(db.all("SELECT DISTINCT account FROM hook_events WHERE session_id = 's3'")).toEqual([{ account: 'business' }]);
    ingest.hook({ hook_event_name: 'Stop', session_id: 's3', cwd: '/Users/me/Documents/x' }, 'personal');
    expect(db.get("SELECT account FROM sessions WHERE session_id = 's3'")).toMatchObject({ account: 'business' });
  });

  it('never stores prompt text, assistant output, transcript paths or tool input (privacy)', () => {
    const db = new Db(':memory:');
    const ingest = new Ingestor(db, () => T0, () => []);
    ingest.hook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 's1',
        cwd: '/x',
        prompt: 'SECRET-PROMPT-TEXT',
        last_assistant_message: 'SECRET-ASSISTANT-OUTPUT',
        transcript_path: '/Users/op/.claude/projects/SECRET-TRANSCRIPT.jsonl',
        tool_input: { command: 'cat SECRET-FILE' },
      },
      'business',
    );
    ingest.logs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [kv('event.name', 'user_prompt'), kv('prompt', 'SECRET-PROMPT-TEXT-2'), kv('tool_parameters', 'SECRET-TOOL')] }] }] }] });
    ingest.metrics(metricsBody({ account: 'business', points: [{ name: 'claude_code.token.usage', value: 5, attrs: { type: 'input', 'prompt.text': 'SECRET-ATTR' } }] }));
    expect(db.dumpText()).not.toMatch(/SECRET/);
    expect(db.dumpText()).toContain('s1');
  });
});

describe('HTTP receiver', () => {
  async function serve() {
    const db = new Db(':memory:');
    const ingest = new Ingestor(db, () => T0, () => envLocations(CONFIG, HOME));
    const server = createCollectorServer(ingest);
    await listen(server, 0);
    const addr = server.address() as AddressInfo;
    const url = (p: string) => `http://127.0.0.1:${addr.port}${p}`;
    return { db, server, addr, url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const json = { 'Content-Type': 'application/json' };

  it('binds to 127.0.0.1 only and answers /health', async () => {
    const s = await serve();
    expect(s.addr.address).toBe('127.0.0.1');
    expect((await fetch(s.url('/health'))).status).toBe(200);
    expect((await fetch(s.url('/nope'))).status).toBe(405);
    await s.close();
  });

  it('accepts OTLP JSON metrics and logs (also gzip), hooks, and rejects protobuf and bad JSON', async () => {
    const s = await serve();
    const metrics = JSON.stringify(metricsBody({ account: 'business', env: 'acme-api', points: [{ name: 'claude_code.token.usage', value: 42, attrs: { type: 'output', model: 'm', 'session.id': 's1' } }] }));
    expect((await fetch(s.url('/v1/metrics'), { method: 'POST', headers: json, body: metrics })).status).toBe(200);
    expect((await fetch(s.url('/v1/metrics'), { method: 'POST', headers: { ...json, 'Content-Encoding': 'gzip' }, body: gzipSync(metrics) })).status).toBe(200);
    expect(s.db.get<{ v: number }>("SELECT SUM(value) AS v FROM usage WHERE kind = 'output'")?.v).toBe(84);

    expect((await fetch(s.url('/v1/logs'), { method: 'POST', headers: json, body: '{"resourceLogs":[]}' })).status).toBe(200);
    const hook = await fetch(s.url('/hooks?account=business'), { method: 'POST', headers: json, body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc', cwd: `${HOME}/work/business/acme-api` }) });
    expect(hook.status).toBe(200);
    expect(s.db.get('SELECT account, env, state FROM sessions')).toMatchObject({ account: 'business', env: 'acme-api', state: 'idle' });

    expect((await fetch(s.url('/v1/metrics'), { method: 'POST', headers: { 'Content-Type': 'application/x-protobuf' }, body: new Uint8Array([1, 2]) })).status).toBe(415);
    expect((await fetch(s.url('/v1/metrics'), { method: 'POST', headers: json, body: '{nope' })).status).toBe(400);
    await s.close();
  });
});

describe('sampler parsers', () => {
  it('ps, process trees and sums', () => {
    const procs = parsePs(`  1     0   0.0   1000 /sbin/launchd\n 100     1   2.5  20480 /opt/homebrew/bin/claude remote-control --name x\n 101   100  10.0  40960 node server.js --port 3000\n 200     1   1.0   2048 other`);
    expect(procs).toHaveLength(4);
    const tree = subtree(procs, 100);
    expect(tree.map((p) => p.pid)).toEqual([100, 101]);
    expect(sumProcs(tree)).toEqual({ cpu: 12.5, rssBytes: (20480 + 40960) * 1024 });
    expect(subtree(procs, 999)).toEqual([]);
  });

  it('vm_stat, sizes, docker, lsof, du, cpu', () => {
    const vm = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                3000.\nPages active:                            100000.\nPages wired down:                         50000.\nPages occupied by compressor:             10000.\n`);
    expect(vm.pageSize).toBe(16384);
    const mem = memoryFromVmStat(vm, 64 * 1024 ** 3);
    expect(mem.used).toBe(160000 * 16384);
    expect(mem.pct).toBeCloseTo((160000 * 16384) / (64 * 1024 ** 3) * 100, 5);

    expect(parseSize('12.5MiB')).toBe(12.5 * 1024 ** 2);
    expect(parseSize('1.5GB')).toBe(1.5e9);
    const stats = parseDockerStats('{"Name":"devhost-acme-api-db-1","CPUPerc":"1.50%","MemUsage":"120MiB / 7.7GiB"}\nnot json\n');
    expect(stats).toEqual([{ name: 'devhost-acme-api-db-1', cpu: 1.5, memBytes: 120 * 1024 ** 2 }]);
    expect([...parseDockerPs('devhost-acme-api-db-1\tdevhost-acme-api\nother\t\n')]).toEqual([['devhost-acme-api-db-1', 'devhost-acme-api']]);
    expect([...parseLsofCwd('p100\nn/Users/op/work/x\np101\nn/tmp\n')]).toEqual([[100, '/Users/op/work/x'], [101, '/tmp']]);
    expect(parseDu('2048\t/some/dir\n')).toBe(2048 * 1024);
    expect(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(75);
    expect(cpuPercent(null, { idle: 1, total: 2 })).toBeNull();
  });
});

// ---- Collector (samplers + alerts) with fake runner / OS / notifier ----

class Recorder implements Notifier {
  readonly provider = 'test';
  sent: Notification[] = [];
  async send(n: Notification): Promise<void> {
    this.sent.push(n);
  }
}

function fakeOs(over: Partial<{ memUsedPct: number; diskFreePct: number }> = {}): { os: OsProbe; set: (o: Partial<{ memUsedPct: number; diskFreePct: number }>) => void } {
  const state = { memUsedPct: 40, diskFreePct: 50, ...over };
  let tick = 0;
  return {
    set: (o) => Object.assign(state, o),
    os: {
      platform: 'linux',
      cpus: () => [{ times: { user: (tick += 50), nice: 0, sys: 0, idle: tick * 3, irq: 0 } }],
      loadavg: () => [1.5, 1, 1],
      totalmem: () => 1000,
      freemem: () => 1000 - state.memUsedPct * 10,
      uptime: () => 3600,
      disk: async () => ({ freeBytes: state.diskFreePct * 10, totalBytes: 1000 }),
    },
  };
}

function setup(over: { runner?: MockRunner; config?: typeof CONFIG; home?: string } = {}) {
  const db = new Db(':memory:');
  const runner = over.runner ?? new MockRunner();
  const notifier = new Recorder();
  const clock = { now: T0 };
  const os = fakeOs();
  const collector = new Collector({ db, config: () => over.config ?? CONFIG, deps: { home: over.home ?? HOME, user: 'op', brewPrefix: '/opt/homebrew', runner }, notifier, now: () => clock.now, os: os.os });
  return { db, runner, notifier, clock, os, collector };
}

describe('Collector sampling', () => {
  it('samples the system and the Remote Control process tree, and attributes a worktree session by its process, never with lsof', async () => {
    const runner = new MockRunner()
      .on('launchctl print system/com.devhost.rc.business.acme-api', { stdout: 'state = running\n\tpid = 100\n' })
      .on('ps', { stdout: ` 100 1 2.0 10240 /opt/homebrew/bin/claude remote-control --name business-acme-api\n 101 100 8.0 20480 /opt/homebrew/Caskroom/claude-code/2.1.300/claude --print --session-id cse_01X\n 102 101 1.0 1024 node dev-server\n 300 1 50.0 99999 unrelated\n` });
    const { db, collector, clock } = setup({ runner });
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: `${HOME}/work/business/acme-api/.claude/worktrees/bridge-cse_01X` }, 'business');

    await collector.sampleTick();
    clock.now += 5000;
    await collector.sampleTick();

    expect(db.all('SELECT * FROM samples_system')).toHaveLength(2);
    expect(db.get('SELECT cpu_pct, mem_pct, disk_free_pct FROM samples_system ORDER BY ts DESC LIMIT 1')).toMatchObject({ mem_pct: 40, disk_free_pct: 50 });
    const env = db.get<{ cpu_pct: number; rss_bytes: number; service_pid: number }>('SELECT * FROM samples_env ORDER BY ts DESC LIMIT 1')!;
    expect(env.service_pid).toBe(100);
    expect(env.cpu_pct).toBe(11);
    expect(env.rss_bytes).toBe((10240 + 20480 + 1024) * 1024);
    // The session is the service's child started with its id, and that child's subtree.
    expect(db.get('SELECT cpu_pct, rss_bytes FROM samples_session ORDER BY ts DESC LIMIT 1')).toMatchObject({ cpu_pct: 9, rss_bytes: (20480 + 1024) * 1024 });
    expect(runner.calls.filter((c) => c.command === 'lsof')).toEqual([]);
    // launchd is asked once; in between, ps still shows the service under its pid.
    expect(runner.calls.filter((c) => c.command === 'launchctl')).toHaveLength(1);
  });

  it('records subagents from their hooks (id and type only), ends them with their session, and counts agents at work', async () => {
    const { db, collector, clock } = setup({ runner: new MockRunner().on('ps', { stdout: '' }) });
    const cwd = `${HOME}/work/business/acme-api`;
    const hook = (b: Record<string, unknown>) => collector.ingest.hook({ cwd, ...b }, 'business');
    hook({ hook_event_name: 'SessionStart', session_id: 's1' });
    hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
    hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a2', agent_type: 'general-purpose' });
    hook({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'SECRET ANSWER', agent_transcript_path: '/x' });
    expect(db.all('SELECT agent_id, agent_type, ended_at IS NOT NULL AS ended FROM agents ORDER BY agent_id')).toEqual([{ agent_id: 'a1', agent_type: 'Explore', ended: 1 }, { agent_id: 'a2', agent_type: 'general-purpose', ended: 0 }]);
    expect(JSON.stringify(db.all('SELECT * FROM hook_events')) + JSON.stringify(db.all('SELECT * FROM agents'))).not.toContain('SECRET');
    expect(db.get("SELECT state FROM sessions WHERE session_id = 's1'")).toMatchObject({ state: 'running' }); // subagent events leave the session's state

    collector.sampleAgents(clock.now);
    expect(db.all('SELECT account, sessions, subagents FROM samples_agents WHERE ts = ? ORDER BY account', clock.now)).toEqual([{ account: '', sessions: 1, subagents: 1 }, { account: 'business', sessions: 1, subagents: 1 }, { account: 'personal', sessions: 0, subagents: 0 }]);

    hook({ hook_event_name: 'SessionEnd', session_id: 's1' });
    expect(db.get("SELECT ended_at IS NOT NULL AS ended FROM agents WHERE agent_id = 'a2'")).toMatchObject({ ended: 1 });
    clock.now += 5000;
    collector.sampleAgents(clock.now);
    expect(db.get("SELECT sessions, subagents FROM samples_agents WHERE ts = ? AND account = ''", clock.now)).toMatchObject({ sessions: 0, subagents: 0 });
  });

  it('rolls agent concurrency up per hour: peaks and average, per account and in total', () => {
    const db = new Db(':memory:');
    const hour = Math.floor(T0 / H) * H;
    for (const [ts, s, a] of [[hour + 1000, 1, 3], [hour + 2000, 2, 0], [hour + 3000, 0, 0]] as const) {
      db.run("INSERT INTO samples_agents VALUES (?, '', ?, ?)", ts, s, a);
    }
    rollup(db, hour + H + 1);
    expect(db.get("SELECT sessions_max, subagents_max, total_max, total_avg, samples FROM rollup_agents WHERE account = ''")).toEqual({ sessions_max: 2, subagents_max: 3, total_max: 4, total_avg: 2, samples: 3 });
  });

  it('a worktree session whose process is gone, quiet for 10 min, is ended; others only after a day without hooks', async () => {
    const runner = new MockRunner()
      .on('launchctl print system/com.devhost.rc.business.acme-api', { stdout: 'state = running\n\tpid = 100\n' })
      .on('ps', { stdout: ` 100 1 2.0 10240 /opt/homebrew/bin/claude remote-control --name business-acme-api\n 101 100 8.0 20480 /opt/homebrew/bin/claude --print --session-id cse_01Alive\n` });
    const { db, collector, clock } = setup({ runner });
    const wt = (key: string) => `${HOME}/work/business/acme-api/.claude/worktrees/bridge-${key}`;
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 'alive', cwd: wt('cse_01Alive') }, 'business');
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 'gone', cwd: wt('cse_01Gone') }, 'business');
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 'terminal', cwd: `${HOME}/work/business/acme-api` }, 'business');
    await collector.sampleTick();
    expect(db.get("SELECT state FROM sessions WHERE session_id = 'gone'")).toMatchObject({ state: 'idle' }); // just started
    clock.now += 11 * 60_000;
    await collector.sampleTick();
    expect(db.all('SELECT session_id, state FROM sessions ORDER BY session_id')).toEqual([{ session_id: 'alive', state: 'idle' }, { session_id: 'gone', state: 'ended' }, { session_id: 'terminal', state: 'idle' }]);
    clock.now += 25 * 3_600_000;
    await collector.sampleTick();
    expect(db.get("SELECT state FROM sessions WHERE session_id = 'terminal'")).toMatchObject({ state: 'ended' });
  });

  it('records the claude.ai session of a session in the environment folder, and ends it once its process is gone', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'claude-'));
    await mkdir(join(claudeDir, 'sessions'));
    await writeFile(join(claudeDir, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: 'own-dir', bridgeSessionId: 'session_01Own' }));
    const config = parseConfig(
      `
machine: { hostname: macmini }
notify: { topic: devhost-abcdefgh }
accounts:
  - { name: personal, default: true, root: ${HOME}/work/personal, portRange: [3000, 3999], git: { name: A, email: a@b.c } }
  - { name: business, configDir: ${claudeDir}, root: ${HOME}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }
environments:
  - { name: acme-api, account: business, portBase: 4100 }
`,
      '/c',
    );
    let ps = ` 100 1 2.0 10240 /opt/homebrew/bin/claude remote-control --name business-acme-api\n 101 100 8.0 20480 /opt/homebrew/bin/claude --print --session-id cse_01Own\n`;
    const runner = new MockRunner()
      .on('launchctl print system/com.devhost.rc.business.acme-api', { stdout: 'state = running\n\tpid = 100\n' })
      .on('ps', () => ({ stdout: ps }));
    const { db, collector, clock } = setup({ runner, config });
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 'own-dir', cwd: `${HOME}/work/business/acme-api` }, 'business');
    await collector.sampleTick();
    expect(db.get("SELECT state, remote_session FROM sessions WHERE session_id = 'own-dir'")).toEqual({ state: 'idle', remote_session: 'session_01Own' });
    ps = ` 100 1 2.0 10240 /opt/homebrew/bin/claude remote-control --name business-acme-api\n`;
    clock.now += 11 * 60_000;
    await collector.sampleTick();
    expect(db.get("SELECT state FROM sessions WHERE session_id = 'own-dir'")).toEqual({ state: 'ended' });
  });

  it('nothing is ended when ps gave no answer', async () => {
    const runner = new MockRunner().on('ps', { code: 1 });
    const { db, collector, clock } = setup({ runner });
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 's', cwd: `${HOME}/work/business/acme-api/.claude/worktrees/bridge-cse_01S` }, 'business');
    clock.now += 60 * 60_000;
    await collector.sampleTick();
    expect(db.get("SELECT state FROM sessions WHERE session_id = 's'")).toMatchObject({ state: 'idle' });
  });

  it('records a service restart when the launchd job gets a new pid', async () => {
    let pid = 100;
    const runner = new MockRunner()
      .on('launchctl print', () => ({ stdout: `state = running\n\tpid = ${pid}\n` }))
      .on('ps', { stdout: '' });
    const { db, collector, clock } = setup({ runner });
    await collector.sampleTick();
    pid = 200;
    clock.now += 5000;
    await collector.sampleTick();
    expect(db.all("SELECT env, pid FROM service_events WHERE kind = 'restart'")).toEqual([{ env: 'acme-api', pid: 200 }]);
  });

  it('maps docker containers to environments through the compose project', async () => {
    const runner = new MockRunner()
      .on('docker info', { stdout: '27.0\n' })
      .on('docker stats', { stdout: '{"Name":"devhost-acme-api-db-1","CPUPerc":"2.00%","MemUsage":"100MiB / 8GiB"}\n{"Name":"unrelated","CPUPerc":"9%","MemUsage":"1GiB / 8GiB"}\n' })
      .on('docker ps', { stdout: 'devhost-acme-api-db-1\tdevhost-acme-api\nunrelated\t\n' })
      .on('launchctl print', { stdout: 'state = running\n\tpid = 100\n' })
      .on('ps', { stdout: ' 100 1 1.0 1024 claude remote-control\n' });
    const { db, collector } = setup({ runner });
    await collector.dockerTick();
    await collector.sampleTick();
    expect(db.kvGet('docker')).toBe('up');
    expect(db.get('SELECT container_cpu_pct, container_mem_bytes FROM samples_env')).toMatchObject({ container_cpu_pct: 2, container_mem_bytes: 100 * 1024 ** 2 });
  });

  it('flags docker as down and a failing sampler never throws', async () => {
    const { db, collector } = setup({ runner: new MockRunner().on('docker info', { code: 1 }) });
    await collector.dockerTick();
    expect(db.kvGet('docker')).toBe('down');
    await expect(collector.sampleTick()).resolves.toBeUndefined(); // ps missing → skipped quietly
  });
});

describe('sleeping environments', () => {
  const project = 'devhost-acme-api';
  const dir = `${HOME}/work/business/acme-api`;
  const running = () =>
    new MockRunner()
      .on('docker info', { stdout: '27.0\n' })
      .on('docker stats', { stdout: `{"Name":"${project}-api-1","CPUPerc":"1.00%","MemUsage":"100MiB / 8GiB"}\n` })
      .on('docker ps', { stdout: `${project}-api-1\t${project}\n` })
      // The model server was stopped by hand: it is not among the running ones; a paused one is.
      .on(`docker compose -p ${project} ps --format {{.Service}} {{.State}}`, { stdout: 'api running\ndb paused\nollama exited\n' })
      .on(/^docker compose -p \S+ (stop|start) /, {});
  const sleeping = async () => {
    const home = await mkdtemp(join(tmpdir(), 'sleep-'));
    const t = setup({ runner: running(), home });
    await t.collector.dockerTick();
    return { ...t, home };
  };

  it('falls asleep after an hour without a session, stopping only the services that ran', async () => {
    const { collector, runner, clock, home } = await sleeping();
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: dir }, 'business');
    collector.ingest.hook({ hook_event_name: 'Stop', session_id: 's1', cwd: dir }, 'business');
    clock.now += 59 * 60_000;
    await collector.sleepTick();
    expect(runner.lines().some((l) => l.includes('compose -p devhost-acme-api stop'))).toBe(false);
    clock.now += 2 * 60_000;
    await collector.sleepTick();
    expect(runner.lines()).toContain(`docker compose -p ${project} stop api db`);
    expect(await sleepState(home, 'acme-api')).toEqual({ at: clock.now, services: ['api', 'db'] });
  });

  it('a session in the middle of a turn keeps it awake; idleSleepMinutes 0 turns it off', async () => {
    const { collector, runner, clock } = await sleeping();
    collector.ingest.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: `${dir}/.claude/worktrees/bridge-cse_01X` }, 'business');
    clock.now += 5 * H;
    await collector.sleepTick();
    expect(runner.lines().some((l) => l.includes(' stop'))).toBe(false);

    const off = { ...CONFIG, docker: { ...CONFIG.docker, idleSleepMinutes: 0 } };
    const t = setup({ runner: running(), config: off, home: await mkdtemp(join(tmpdir(), 'sleep-')) });
    await t.collector.dockerTick();
    t.clock.now += 5 * H;
    await t.collector.sleepTick();
    expect(t.runner.lines().some((l) => l.includes(' stop'))).toBe(false);
  });

  it('wakes with the next session, starting the services it stopped and no others', async () => {
    const { collector, runner, clock, home } = await sleeping();
    clock.now += 2 * H;
    await collector.sleepTick();
    expect(await sleepState(home, 'acme-api')).not.toBeNull();
    collector.ingest.hook({ hook_event_name: 'SessionStart', session_id: 's2', cwd: `${dir}/.claude/worktrees/bridge-cse_01Y` }, 'business');
    await vi.waitFor(() => expect(runner.lines()).toContain(`docker compose -p ${project} start api db`));
    await vi.waitFor(async () => expect(await sleepState(home, 'acme-api')).toBeNull());
    // Just woken: not put to sleep again on the next tick.
    clock.now += 60_000;
    await collector.sleepTick();
    expect(runner.lines().filter((l) => l.endsWith('stop api db'))).toHaveLength(1);
  });
});

describe('alerts', () => {
  it('notifies once per state change: memory (5 min), disk, cost, restarts, with recovery', async () => {
    const { db, collector, notifier, clock, os } = setup({ runner: new MockRunner().on('ps', { stdout: '' }).on('launchctl', { code: 1 }) });
    const msgs = () => notifier.sent.map((n) => n.message);

    // Memory: above 90% only counts after 5 minutes.
    os.set({ memUsedPct: 95 });
    await collector.sampleTick();
    expect(notifier.sent).toHaveLength(0);
    clock.now += 4 * 60_000;
    await collector.sampleTick();
    expect(notifier.sent).toHaveLength(0);
    clock.now += 2 * 60_000;
    await collector.sampleTick();
    expect(msgs()).toEqual([expect.stringContaining('Memory above 90% for 5 min')]);
    clock.now += 60_000;
    await collector.sampleTick(); // still high: no second notification
    expect(notifier.sent).toHaveLength(1);
    os.set({ memUsedPct: 40 });
    clock.now += 60_000;
    await collector.sampleTick();
    expect(msgs().at(-1)).toContain('back below');
    expect(notifier.sent).toHaveLength(2);

    // Disk
    os.set({ diskFreePct: 10 });
    await collector.sampleTick();
    expect(msgs().at(-1)).toContain('Free disk space is 10.0%');

    // Cost: business has a $10 limit; personal none.
    db.run("INSERT INTO usage VALUES (?, 'business', '', 's', 'm', 'cost', 12)", clock.now);
    db.run("INSERT INTO usage VALUES (?, 'personal', '', 's', 'm', 'cost', 99)", clock.now);
    await collector.sampleTick();
    expect(msgs().filter((m) => m.includes('Estimated cost today'))).toHaveLength(1);
    expect(msgs().at(-1)).toContain('business');
    expect(msgs().at(-1)).toContain('not billed money');

    // Restarts: more than 3 in 10 minutes.
    for (let i = 0; i < 4; i++) db.run("INSERT INTO service_events VALUES (?, 'business', 'acme-api', 'restart', ?)", clock.now - i * 1000, 500 + i);
    await collector.sampleTick();
    expect(msgs().at(-1)).toContain('restarted 4 times in 10 min');
    expect(collector.alerts.active().map((a) => a.id).sort()).toEqual(['cost:business', 'disk', 'restarts:acme-api']);
  });

  it('auth: one notification on change, a reminder after 24 h, recovery on re-login', async () => {
    const db = new Db(':memory:');
    const notifier = new Recorder();
    let now = T0;
    const engine = new AlertEngine(db, notifier, () => now);
    const th = { memoryPercent: 90, diskFreePercent: 15, dailyCostUsd: new Map() };
    const input = (valid: boolean) => ({ memPct: null, diskFreePct: null, costToday: new Map(), restarts: new Map(), auth: new Map([['business', valid]]) });

    await engine.evaluate(th, input(true));
    expect(notifier.sent).toHaveLength(0); // never alerted, nothing to recover from
    await engine.evaluate(th, input(false));
    expect(notifier.sent.map((n) => n.message)).toEqual(['Claude login not valid: business. Run: devhost login business']);
    now += 3 * H;
    await engine.evaluate(th, input(false));
    expect(notifier.sent).toHaveLength(1);
    now += 22 * H;
    await engine.evaluate(th, input(false));
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[1]!.message).toMatch(/^Reminder: Claude login not valid: business/);
    await engine.evaluate(th, input(true));
    expect(notifier.sent[2]!.message).toContain('valid again');
  });

  it('environment cost: a daily limit, and an hourly one over the last 60 minutes that names the top session and clears at 80%', async () => {
    const db = new Db(':memory:');
    const notifier = new Recorder();
    let now = T0;
    const engine = new AlertEngine(db, notifier, () => now);
    const th = { memoryPercent: 90, diskFreePercent: 15, dailyCostUsd: new Map(), envCost: new Map([['business/acme-api', { dailyUsd: 5, hourlyUsd: 2 }], ['personal/web', { dailyUsd: null, hourlyUsd: null }]]) };
    const evalAt = () => engine.evaluate(th, { memPct: null, diskFreePct: null, costToday: new Map(), restarts: new Map(), auth: new Map(), envCost: envCosts(db, now) });
    const msgs = () => notifier.sent.map((n) => n.message);
    const cost = (ts: number, env: string, session: string, value: number) => db.run("INSERT INTO usage VALUES (?, 'business', ?, ?, 'm', 'cost', ?)", ts, env, session, value);

    cost(now - 10 * 60_000, 'acme-api', 'sess-small00', 0.5);
    cost(now - 5 * 60_000, 'acme-api', 'sess-loop1234', 1.8);
    db.run("INSERT INTO usage VALUES (?, 'personal', 'web', 's', 'm', 'cost', 99)", now); // no limits: no alert
    await evalAt();
    expect(msgs()).toEqual([expect.stringContaining('Environment business/acme-api spent $2.30 in the last hour (limit $2)')]);
    expect(notifier.sent[0]!.message).toContain('session sess-loo');
    expect(notifier.sent[0]!.priority).toBe('high');

    // Still at 85% of the limit an hour later: not cleared yet (hysteresis), no new notification.
    now += 50 * 60_000;
    cost(now, 'acme-api', 'sess-loop1234', 1.7);
    await evalAt();
    expect(notifier.sent).toHaveLength(1);
    now += 15 * 60_000; // the 1.8 and 0.5 left the window: 1.7 is 85% of 2
    await evalAt();
    expect(notifier.sent).toHaveLength(1);
    now += 50 * 60_000; // nothing in the last hour
    await evalAt();
    expect(msgs().at(-1)).toContain('below');

    // Daily: 0.5 + 1.8 + 1.7 + 1.5 passes $5.
    cost(now, 'acme-api', 'sess-other00', 1.5);
    await evalAt();
    expect(msgs().filter((m) => m.includes('Estimated cost today in environment business/acme-api is $5.50 (limit $5)'))).toHaveLength(1);
    expect(engine.active().map((a) => a.id)).toContain('envcost:business/acme-api');
  });

  it('a failing notifier does not break evaluation', async () => {
    const db = new Db(':memory:');
    const failing: Notifier = { provider: 'x', send: async () => { throw new Error('offline'); } };
    const logs: string[] = [];
    const engine = new AlertEngine(db, failing, () => T0, (m) => logs.push(m));
    await engine.evaluate({ memoryPercent: 90, diskFreePercent: 15, dailyCostUsd: new Map() }, { memPct: null, diskFreePct: 1, costToday: new Map(), restarts: new Map(), auth: new Map() });
    expect(logs[0]).toContain('notification failed');
    expect(db.get('SELECT active FROM alert_state WHERE id = ?', 'disk')).toMatchObject({ active: 1 });
  });
});

describe('session titles', () => {
  it('reads the newest title from the transcript in any account directory, else the last prompt', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'titles-'));
    const cwd = '/Users/me/work/b/x/.claude/worktrees/bridge-cse_01';
    expect(projectSlug(cwd)).toBe('-Users-me-work-b-x--claude-worktrees-bridge-cse-01');
    const put = async (dir: string, id: string, records: object[]) => {
      await mkdir(join(root, dir, 'projects', projectSlug(cwd)), { recursive: true });
      await writeFile(join(root, dir, 'projects', projectSlug(cwd), `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    };
    const dirs = [join(root, 'a'), join(root, 'b')];
    await put('b', 's1', [{ type: 'custom-title', customTitle: 'Old' }, { type: 'user', message: { content: 'hi' } }, { type: 'custom-title', customTitle: 'New title' }]);
    expect(await sessionTitle(dirs, cwd, 's1')).toEqual({ title: 'New title', fromPrompt: false });
    await put('a', 's2', [{ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } }, { type: 'user', message: { content: 'please\n  fix it' } }]);
    expect(await sessionTitle(dirs, cwd, 's2')).toEqual({ title: 'please fix it', fromPrompt: true });
    await put('a', 's3', [{ type: 'last-prompt', lastPrompt: 'x'.repeat(300) }]);
    expect((await sessionTitle(dirs, cwd, 's3'))?.title).toHaveLength(100);
    expect(await sessionTitle(dirs, cwd, 'missing')).toBeUndefined();
    expect(await sessionTitle(dirs, cwd, '../s1')).toBeUndefined();
  });
});

describe('auth check', () => {
  it('runs `claude auth status` per account; the default account with CLAUDE_CONFIG_DIR unset; marks invalid logins', async () => {
    const runner = new MockRunner()
      .on('sh -c command -v claude', { stdout: '/opt/homebrew/bin/claude\n' })
      .on('/opt/homebrew/bin/claude auth status', (c) => ({ code: c.opts?.env?.['CLAUDE_CONFIG_DIR'] ? 1 : 0 }));
    const { db, collector, notifier } = setup({ runner });
    await collector.authTick();
    const calls = runner.calls.filter((c) => c.args[0] === 'auth');
    const byEnv = calls.map((c) => [c.opts?.env?.['CLAUDE_CONFIG_DIR'] ?? null, c.opts?.unsetEnv ?? []]);
    expect(byEnv).toEqual([[null, ['CLAUDE_CONFIG_DIR']], [`${HOME}/.claude-business`, []]]);
    expect(db.kvGet('auth:personal')).toBe('ok');
    expect(db.kvGet('auth:business')).toBe('invalid');
    await collector.sampleTick();
    expect(notifier.sent.map((n) => n.message)).toContain('Claude login not valid: business. Run: devhost login business');
  });

  it("records which organization and email are which account's login; an email two accounts share decides nothing", async () => {
    const runner = new MockRunner()
      .on('sh -c command -v claude', { stdout: '/opt/homebrew/bin/claude\n' })
      .on('/opt/homebrew/bin/claude auth status', (c) => ({ stdout: JSON.stringify({ loggedIn: true, email: 'me@same.example', orgId: c.opts?.env?.['CLAUDE_CONFIG_DIR'] ? 'org-work' : 'org-me' }) }));
    const { db, collector } = setup({ runner });
    db.kvSet('auth_email:me@same.example', 'personal', 1);
    await collector.authTick();
    expect(db.kvGet('auth_org:org-me')).toBe('personal');
    expect(db.kvGet('auth_org:org-work')).toBe('business');
    expect(db.kvGet('auth_email:me@same.example')).toBeNull();
  });

  it('authProbe also needs a real request to succeed', async () => {
    const config = parseConfig(`machine: { hostname: m }\nnotify: { topic: devhost-abcdefgh }\ncollector: { authProbe: true }\naccounts:\n  - { name: a, default: true, root: ${HOME}/w, portRange: [3000, 3999], git: { name: A, email: a@b.c } }`, '/c');
    const runner = new MockRunner()
      .on('sh -c command -v claude', { stdout: '/opt/homebrew/bin/claude\n' })
      .on('/opt/homebrew/bin/claude auth status', { code: 0 })
      .on('/opt/homebrew/bin/claude -p ok --max-turns 1', { code: 1, stderr: 'Login expired' });
    const { db, collector } = setup({ runner, config });
    await collector.authTick();
    expect(db.kvGet('auth:a')).toBe('invalid');
  });
});

describe('rollup and retention', () => {
  it('rolls up completed hours, drops old raw rows and never double-counts in the dashboard', () => {
    const db = new Db(':memory:');
    const day = 24 * H;
    const now = T0 + 10 * day;
    // 9 days ago (older than 7 raw days), 2 days ago, and 20 minutes ago.
    for (const [ts, v] of [[now - 9 * day, 1], [now - 2 * day, 2], [now - 20 * 60_000, 4]] as const) {
      db.run("INSERT INTO usage VALUES (?, 'business', 'acme-api', 's1', 'm', 'output', ?)", ts, v);
      db.run("INSERT INTO usage VALUES (?, 'business', 'acme-api', 's1', 'm', 'cost', ?)", ts, v / 10);
    }
    const before = buildDash(db, CONFIG, { range: '30d' }, now, 'mini', null);
    const sum = (d: DashData) => d.usage.reduce((a, r) => a + r.output, 0);
    expect(sum(before)).toBe(7);

    rollup(db, now);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rollup_usage')?.n).toBe(6); // 3 hours × (output, cost)
    retain(db, now, { rawDays: 7, rollupDays: 365 });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage')?.n).toBe(4); // the 9-day-old rows are gone
    // The dashboard reads old hours from rollups and newer data from raw rows: totals are unchanged.
    expect(sum(buildDash(db, CONFIG, { range: '30d' }, now, 'mini', null))).toBe(7);

    // Rollups past rollupDays are deleted; raw data is only dropped once it is rolled up.
    retain(db, now + 400 * day, { rawDays: 7, rollupDays: 365 });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rollup_usage')?.n).toBe(0);
    rollup(db, now); // idempotent
  });
});

describe('dashboard', () => {
  function populated() {
    const db = new Db(':memory:');
    const now = T0 + 30 * 60_000;
    const ingest = new Ingestor(db, () => now - 600_000, () => envLocations(CONFIG, HOME));
    ingest.hook({ hook_event_name: 'SessionStart', session_id: 'sess-aaaa1111', cwd: `${HOME}/work/business/acme-api` }, 'business');
    ingest.hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'sess-aaaa1111', cwd: `${HOME}/work/business/acme-api` }, 'business');
    ingest.metrics(metricsBody({ account: 'business', env: 'acme-api', points: [
      { name: 'claude_code.token.usage', value: 1000, attrs: { type: 'input', model: 'm1', 'session.id': 'sess-aaaa1111' } },
      { name: 'claude_code.token.usage', value: 200, attrs: { type: 'output', model: 'm1', 'session.id': 'sess-aaaa1111' } },
      { name: 'claude_code.cost.usage', value: 1.25, attrs: { model: 'm1', 'session.id': 'sess-aaaa1111' } },
    ] }));
    db.run('INSERT INTO samples_system (ts, cpu_pct, mem_pct, mem_used, mem_total, disk_free_pct, disk_free_bytes, load1) VALUES (?, 12.5, 41, 100, 1000, 33, 500, 1)', now - 1000);
    db.run('INSERT INTO samples_env VALUES (?, ?, ?, 7, 52428800, 2, 1048576, 123)', now - 1000, 'business', 'acme-api');
    db.run('INSERT INTO samples_session VALUES (?, ?, 3, 1048576)', now - 1000, 'sess-aaaa1111');
    db.kvSet('docker', 'up', now);
    db.kvSet('tailscale', JSON.stringify({ state: 'Running', dnsName: 'macmini.tail1234.ts.net' }), now);
    db.kvSet('auth:business', 'invalid', now);
    db.kvSet('auth:personal', 'ok', now);
    return { db, now };
  }

  it('builds a snapshot that matches the contract, with filters', () => {
    const { db, now } = populated();
    const data = buildDash(db, CONFIG, { range: '24h' }, now, 'macmini', 4096);
    expect(validate('result.dash', data).ok, JSON.stringify(validate('result.dash', data).issues)).toBe(true);
    expect(data.host).toMatchObject({ name: 'macmini', online: true, cpuPercent: 12.5, memPercent: 41, docker: 'up', tailscale: { state: 'Running', dnsName: 'macmini.tail1234.ts.net' } });
    const business = data.accounts.find((a) => a.name === 'business')!;
    expect(business).toMatchObject({ loggedIn: false, today: { tokens: 1200, costUsd: 1.25 }, dailyCostAlertUsd: 10 });
    expect(data.accounts.find((a) => a.name === 'personal')).toMatchObject({ loggedIn: true, today: { tokens: 0, costUsd: 0 } });
    expect(data.environments[0]).toMatchObject({ account: 'business', name: 'acme-api', service: { state: 'running', pid: 123 }, cpuPercent: 7, containerMemBytes: 1048576, portBase: 4100, activeSessions: 1, costToday: 1.25, costLastHour: 1.25, costAlert: { dailyUsd: 5, hourlyUsd: 2 } });
    expect(data.sessions[0]).toMatchObject({ id: 'sess-aaaa1111', state: 'waiting', tokensToday: 1200, costToday: 1.25, cpuPercent: 3 });
    expect(data.usage.reduce((a, r) => a + r.input + r.output, 0)).toBe(1200);
    expect(data.limits.join(' ')).toContain('estimate');
    expect(data.collector).toMatchObject({ dbSizeBytes: 4096, schemaVersion: 8 });

    expect(buildDash(db, CONFIG, { range: '24h', account: 'personal' }, now, 'm', null).sessions).toEqual([]);
    expect(buildDash(db, CONFIG, { range: '24h', env: 'acme-api', model: 'other' }, now, 'm', null).usage).toEqual([]);
  });

  it("shows each session's subagents and how many agents worked at once", () => {
    const { db, now } = populated();
    db.run("INSERT INTO agents VALUES ('a1', 'sess-aaaa1111', 'Explore', ?, NULL)", now - 60_000);
    db.run("INSERT INTO agents VALUES ('a2', 'sess-aaaa1111', 'Explore', ?, ?)", now - 120_000, now - 90_000);
    db.run("INSERT INTO agents VALUES ('a3', 'sess-aaaa1111', 'Plan', ?, ?)", now - 120_000, now - 90_000);
    const bucket = (t: number) => Math.floor(t / H) * H;
    for (const [ts, sessions, subagents] of [[now - 5 * H, 1, 3], [now - 5 * H + 5000, 2, 0], [now - 10_000, 1, 1]] as const) {
      db.run("INSERT INTO samples_agents VALUES (?, '', ?, ?)", ts, sessions, subagents);
      db.run("INSERT INTO samples_agents VALUES (?, 'business', ?, ?)", ts, sessions, subagents);
    }
    const data = buildDash(db, CONFIG, { range: '24h' }, now, 'm', null);
    expect(validate('result.dash', data).ok, JSON.stringify(validate('result.dash', data).issues)).toBe(true);
    expect(data.sessions[0]!.subagents).toEqual({ running: 1, total: 3, types: ['Explore', 'Plan'] });
    expect(data.agents!.now).toEqual({ sessions: 1, subagents: 1 });
    expect(data.agents!.peak).toEqual({ total: 4, at: bucket(now - 5 * H) });
    expect(data.agents!.buckets.find((b) => b.ts === bucket(now - 5 * H))).toEqual({ ts: bucket(now - 5 * H), sessions: 2, subagents: 3, total: 4 });
    expect(buildDash(db, CONFIG, { range: '24h', account: 'personal' }, now, 'm', null).agents).toEqual({ now: { sessions: 0, subagents: 0 }, peak: { total: 0, at: null }, buckets: [] });
  });

  it('top renders a readable table with alerts and waiting sessions', () => {
    const { db, now } = populated();
    db.run("INSERT INTO alert_state VALUES ('disk', 1, ?, ?, 'Free disk space is 10.0%')", now, now);
    const text = renderTop(buildDash(db, CONFIG, { range: '1h' }, now, 'macmini', null));
    expect(text).toContain('macmini  online');
    expect(text).toContain('ALERT disk: Free disk space is 10.0%');
    expect(text).toMatch(/business\s+INVALID/);
    expect(text).toMatch(/business\/acme-api\s+running/);
    expect(text).toMatch(/WAITING/);
    expect(text).not.toContain('\u001b[');
  });
});

describe('notifications', () => {
  it('posts to ntfy with title, priority and tags; surfaces HTTP errors', async () => {
    const calls: { url: string; init: { body: string; headers: Record<string, string> } }[] = [];
    const ok = new NtfyNotifier('https://ntfy.example/', 'my topic', async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 }));
    await ok.send({ title: 'T', message: 'hello', priority: 'high', tags: ['warning'] });
    expect(calls[0]).toMatchObject({ url: 'https://ntfy.example/my%20topic', init: { body: 'hello', headers: { Title: 'T', Priority: 'high', Tags: 'warning' } } });
    await expect(new NtfyNotifier('https://x', 't', async () => ({ ok: false, status: 503 })).send({ title: 't', message: 'm' })).rejects.toThrow('HTTP 503');
    expect(createNotifier(CONFIG).provider).toBe('ntfy');
    expect(maskTopic('devhost-abcdefgh')).toBe('devh…');
  });
});

describe('commands', () => {
  async function initialized() {
    const mac = fakeMac();
    const env = await makeEnv(mac.runner);
    await env.run('init', '--yes', '--docker', 'none', '--no-tailscale');
    env.out.length = 0;
    return { env, mac };
  }

  it('dash and top fail clearly before the collector has produced data', async () => {
    const { env } = await initialized();
    expect(await env.run('dash', '--json')).toBe(1);
    const e = JSON.parse(env.stdout()) as Envelope;
    expect(e.errors[0]).toMatchObject({ code: 'no-data' });
  });

  it('dash --json returns a valid snapshot; --range is validated; top --once prints the table', async () => {
    const { env } = await initialized();
    const db = new Db(dbPath(env.home));
    db.run('INSERT INTO samples_system (ts, cpu_pct, mem_pct, mem_used, mem_total, disk_free_pct, disk_free_bytes, load1) VALUES (?, 5, 30, 1, 2, 60, 10, 1)', env.deps.now().getTime());
    db.close();
    expect(await env.run('dash', '--json', '--range', '7d')).toBe(0);
    const e = JSON.parse(env.stdout()) as Envelope;
    expect(validate('result.dash', e.data).ok).toBe(true);
    expect((e.data as DashData).range).toBe('7d');
    env.out.length = 0;
    expect(await env.run('dash', '--range', '2y')).toBe(2);
    expect(await env.run('top', '--once')).toBe(0);
    expect(env.stdout()).toContain('ACCOUNT');
  });

  it('dash --follow --json streams snapshot events until cancelled', async () => {
    const { env } = await initialized();
    const db = new Db(dbPath(env.home));
    db.run('INSERT INTO samples_system (ts, cpu_pct, mem_pct, mem_used, mem_total, disk_free_pct, disk_free_bytes, load1) VALUES (?, 5, 30, 1, 2, 60, 10, 1)', env.deps.now().getTime());
    db.close();
    await env.run('config', 'set', '/collector/sampleIntervalSeconds', '1');
    env.out.length = 0;
    setTimeout(() => (env.deps.cancel.cancelled = true), 300);
    expect(await env.run('dash', '--follow', '--json')).toBe(0);
    const events = ndjson(env.stdout());
    expect(events.filter((x) => (x as { type: string }).type === 'snapshot').length).toBeGreaterThanOrEqual(1);
    for (const x of events) expect(validate('events', x).ok, JSON.stringify(x)).toBe(true);
  });

  it('notify --test sends through the provider and masks the topic', async () => {
    const { env } = await initialized();
    const { notifyCommand } = await import('../src/commands-collector.js');
    const sent: string[] = [];
    const g = { json: true, verbose: false, yes: false, configPath: join(env.home, '.config', 'devhost', 'config.yaml') };
    expect(await notifyCommand(env.deps, g, { test: true }, async (url) => (sent.push(url), { ok: true, status: 200 }))).toBe(0);
    const e = JSON.parse(env.stdout()) as Envelope;
    expect(validate('result.notify', e.data).ok).toBe(true);
    expect(sent[0]).toMatch(/^https:\/\/ntfy\.sh\/devhost-/);
    expect(JSON.stringify(e.data)).not.toMatch(/devhost-[a-z0-9]{16}/);
    expect(await notifyCommand(env.deps, g, { test: false })).toBe(2);
  });

  it('apply installs the collector as a boot-time service running `collector run`', async () => {
    const { env, mac } = await initialized();
    expect(await env.run('apply')).toBe(0);
    const plist = await readFile(join(env.home, 'LaunchDaemons', 'com.devhost.collector.plist'), 'utf8');
    expect(plist).toContain('<string>--disable-warning=ExperimentalWarning</string>');
    expect(plist).toContain('<string>collector</string>\n    <string>run</string>');
    expect(plist).toContain(`<string>${join(env.home, '.config', 'devhost', 'config.yaml')}</string>`);
    expect(plist).toContain('<string>tester</string>');
    expect(mac.state.loaded.has('com.devhost.collector')).toBe(true);
  });
});

describe('service log retention', () => {
  it('rotates each log once a day into gzip archives, keeps `days` of them, empties the log in place, removes stale logs', async () => {
    const { mkdtemp, writeFile, readFile, readdir, utimes, appendFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { gunzipSync } = await import('node:zlib');
    const { rotateLogs } = await import('../src/collector/logs.js');
    const dir = await mkdtemp(join(tmpdir(), 'logs-'));
    const D = 24 * 3_600_000;
    let t = Date.now();
    const seen = new Map<string, number>();
    const rotate = () => rotateLogs(dir, t, 3, (n) => seen.get(n) ?? null, (n, at) => seen.set(n, at));
    await writeFile(join(dir, 'rc-a.log'), 'day0\n');
    await writeFile(join(dir, 'notes.txt'), 'not a log\n');
    await writeFile(join(dir, 'rc-old.log'), 'gone\n');
    await writeFile(join(dir, 'rc-old.log.1.gz'), 'x');
    await utimes(join(dir, 'rc-old.log'), (t - 4 * D) / 1000, (t - 4 * D) / 1000);

    expect(await rotate()).toEqual(['rc-a.log']); // first seen: right away
    expect(await readFile(join(dir, 'rc-a.log'), 'utf8')).toBe('');
    expect(gunzipSync(await readFile(join(dir, 'rc-a.log.1.gz'))).toString()).toBe('day0\n');
    expect(await rotate()).toEqual([]); // not again the same day

    for (let day = 1; day <= 4; day++) {
      t += D;
      await appendFile(join(dir, 'rc-a.log'), `day${day}\n`);
      await utimes(join(dir, 'rc-a.log'), t / 1000, t / 1000);
      expect(await rotate()).toEqual(['rc-a.log']);
    }
    expect((await readdir(dir)).sort()).toEqual(['notes.txt', 'rc-a.log', 'rc-a.log.1.gz', 'rc-a.log.2.gz', 'rc-a.log.3.gz']);
    expect(gunzipSync(await readFile(join(dir, 'rc-a.log.1.gz'))).toString()).toBe('day4\n');
    expect(gunzipSync(await readFile(join(dir, 'rc-a.log.3.gz'))).toString()).toBe('day2\n');
  });
});

describe('Collector Claude Code updates', () => {
  const result = (data: unknown, ok = true) => ({ stdout: `{"type":"step","id":"update.check","status":"start"}\n${JSON.stringify({ type: 'result', ok, data })}\n` });
  const claude = (installed: string, latest: string) => ({ install: 'brew', path: '/opt/homebrew/bin/claude', installed, latest, outdated: installed !== latest });

  function updating(mode?: 'auto' | 'notify', answers: Record<string, unknown>[] = []) {
    const calls: string[] = [];
    const runner = new MockRunner().on(/^devhost update/, (call) => {
      const line = [call.command, ...call.args].join(' ');
      calls.push(line);
      if (line.includes('--check')) return result({ claude: claude('2.1.300', '2.1.310'), packages: [{ name: 'gh', installed: '1', latest: '2', cask: false }], checkedAt: 0 });
      return result(answers.shift() ?? {}, true);
    });
    const db = new Db(':memory:');
    const notifier = new Recorder();
    const clock = { now: T0 };
    const config = mode ? parseConfig(`machine: { hostname: macmini }\nnotify: { topic: devhost-abcdefgh }\nclaude: { update: ${mode} }\n`, '/c') : CONFIG;
    const collector = new Collector({ db, config: () => config, deps: { home: HOME, user: 'op', brewPrefix: '/opt/homebrew', runner }, notifier, now: () => clock.now, os: fakeOs().os, selfCommand: ['devhost'] });
    const state = () => JSON.parse(db.kvGet('update') ?? 'null') as NonNullable<DashData['updates']>;
    return { calls, notifier, clock, collector, state, db };
  }

  it('checks once a day, updates only inside the window, waits for busy sessions, then reports the update', async () => {
    const u = updating(undefined, [
      { claude: claude('2.1.300', '2.1.310'), packages: [], checkedAt: 0, busy: ['business/acme-api · 5e000000'] },
      { claude: { ...claude('2.1.310', '2.1.310'), updated: true }, packages: [], checkedAt: 0, restarted: ['com.devhost.rc.business.acme-api'], detached: [{ remoteSession: 'session_01', account: 'business', env: 'acme-api', url: 'https://claude.ai/code/session_01' }] },
    ]);
    await u.collector.updateTick(); // noon: outside 02:00-06:00
    expect(u.calls).toEqual(['devhost update --check --json']);
    expect(u.state()).toMatchObject({ claude: { installed: '2.1.300', latest: '2.1.310', outdated: true }, packages: 1, mode: 'auto', waiting: 'updates run between 02:00 and 06:00' });
    await u.collector.updateTick(); // no new check within the day
    expect(u.calls).toHaveLength(1);

    u.clock.now = T0 + 15 * 3_600_000; // 03:00 the next day (the check from noon still counts)
    await u.collector.updateTick();
    expect(u.calls.slice(1)).toEqual(['devhost update --json']);
    expect(u.state().waiting).toBe('1 session(s) in the middle of a turn');
    expect(u.notifier.sent).toEqual([]);

    u.clock.now += 3_600_000;
    await u.collector.updateTick();
    expect(u.state()).toMatchObject({ claude: { installed: '2.1.310', outdated: false }, lastUpdate: { ok: true } });
    expect(u.state().waiting).toBeUndefined();
    expect(u.notifier.sent.map((n) => n.message)).toEqual(['Claude Code 2.1.300 → 2.1.310; 1 service(s) restarted; 1 open session(s) continue on claude.ai when you write in them.']);
    const dash = buildDash(u.db, CONFIG, { range: '24h' }, u.clock.now, 'macmini', null);
    expect(dash.updates?.claude.outdated).toBe(false);
  });

  it('notify mode only tells, once per version', async () => {
    const u = updating('notify');
    await u.collector.updateTick();
    u.clock.now += 21 * 3_600_000;
    await u.collector.updateTick();
    expect(u.calls).toEqual(['devhost update --check --json', 'devhost update --check --json']);
    expect(u.notifier.sent).toHaveLength(1);
    expect(u.notifier.sent[0]!.message).toContain('Claude Code 2.1.310 is available');
  });
});

describe('where requests come from', () => {
  it('names a query_source as the main thread, a built-in subagent type, custom agents or compaction', () => {
    expect(['repl_main_thread', 'repl_main_thread:outputStyle:Concise', 'agent:builtin:Explore', 'agent:builtin:', 'agent:custom', 'agent:custom:reviewer', 'compact', 'web_search_tool', ''].map(sourceOf)).toEqual(
      ['main', 'main', 'Explore', 'builtin agent', 'custom agents', 'custom agents', 'compaction', 'web_search_tool', ''],
    );
  });

  it('ingests the source, rolls it up, and the stats plugin shows what subagents cost and what the main thread read', async () => {
    const db = new Db(':memory:');
    let now = T0;
    const ingest = new Ingestor(db, () => now, () => []);
    const call = (source: string, cost: number, cacheRead: number, ts = T0) => ({ timeUnixNano: String(BigInt(ts) * 1_000_000n), attributes: [kv('event.name', 'api_request'), kv('model', 'm1'), kv('input_tokens', 100), kv('output_tokens', 10), kv('cache_read_tokens', cacheRead), kv('cost_usd', cost), kv('query_source', source), kv('session.id', 's1')] });
    const body = (...records: ReturnType<typeof call>[]) => ({ resourceLogs: [{ resource: { attributes: [kv('devhost.account', 'business')] }, scopeLogs: [{ logRecords: records }] }] });
    ingest.logs(body(call('repl_main_thread', 0.5, 50_000), call('repl_main_thread', 0.5, 60_000), call('agent:builtin:Explore', 0.1, 4_000), call('agent:custom:explorer', 0.05, 2_000)));
    now = T0 + 2 * H; // the hour has ended: rolled up, and the raw rows are still there for the next hour's rows
    rollup(db, now);
    ingest.logs(body(call('agent:builtin:Explore', 0.1, 5_000, T0 + 2 * H)));
    expect(db.all('SELECT source, requests FROM rollup_source ORDER BY source')).toEqual([{ source: 'Explore', requests: 1 }, { source: 'custom agents', requests: 1 }, { source: 'main', requests: 2 }]);
    const dash = buildDash(db, CONFIG, { range: '24h' }, T0 + 2 * H + 60_000, 'macmini', null);
    expect(validate('result.dash', dash).ok).toBe(true);
    expect(dash.sources!.map((x) => [x.source, x.requests, Math.round(x.costUsd * 100) / 100])).toEqual([['main', 2, 1], ['Explore', 2, 0.2], ['custom agents', 1, 0.05]]);
    expect(buildDash(db, CONFIG, { range: '24h', model: 'other' }, T0 + 2 * H + 60_000, 'macmini', null).sources).toBeNull();
    const { stats: statsPlugin } = await import('../src/plugins/builtin/stats.js');
    const w = (await statsPlugin.widgets!.find((x) => x.id === 'sources')!.run({ stats: async () => dash } as unknown as PluginContext, { range: '24h' })) as WidgetContent;
    expect(w.summary).toBe('Subagents: 20% of the cost ($0.25), 9% of the tokens');
    expect(w.tiles!.map((t) => [t.label, t.value])).toEqual([['Main thread', '$1.00'], ['Subagents', '$0.25'], ['In all', '$1.25']]);
    expect(w.rows!.map((r) => r.label)).toEqual(['main', 'Explore', 'custom agents']);
  });

  it('gives the token mix per model and bucket, and the stats plugin compares the halves of the range', async () => {
    const db = new Db(':memory:');
    let now = T0;
    const ingest = new Ingestor(db, () => now, () => []);
    const call = (model: string, output: number, ts: number) => ({ timeUnixNano: String(BigInt(ts) * 1_000_000n), attributes: [kv('event.name', 'api_request'), kv('model', model), kv('input_tokens', 0), kv('output_tokens', output), kv('cache_read_tokens', 9_000), kv('cache_creation_tokens', 1_000), kv('cost_usd', 0.01), kv('query_source', 'repl_main_thread'), kv('session.id', 's1')] });
    const body = (...records: ReturnType<typeof call>[]) => ({ resourceLogs: [{ resource: { attributes: [kv('devhost.account', 'business')] }, scopeLogs: [{ logRecords: records }] }] });
    ingest.logs(body(call('m1', 500, T0), call('m1', 500, T0 + 60_000), call('m2', 2_000, T0 + 120_000)));
    now = T0 + 20 * H;
    rollup(db, now); // the early hour from rollup_source, the late one raw
    ingest.logs(body(call('m1', 1_000, now)));
    const dash = buildDash(db, CONFIG, { range: '24h' }, now, 'macmini', null);
    expect(validate('result.dash', dash).ok).toBe(true);
    expect(dash.tokens!.map((r) => [r.ts - T0, r.model, r.requests, r.output])).toEqual([[0, 'm1', 2, 1_000], [0, 'm2', 1, 2_000], [20 * H, 'm1', 1, 1_000]]);
    expect(buildDash(db, CONFIG, { range: '24h', model: 'm2' }, now, 'macmini', null).tokens).toHaveLength(1);
    const { stats: statsPlugin } = await import('../src/plugins/builtin/stats.js');
    const run = async (id: string) => (await statsPlugin.widgets!.find((x) => x.id === id)!.run({ stats: async () => dash } as unknown as PluginContext, { range: '24h' })) as WidgetContent;
    const mix = await run('tokens');
    expect(mix.tiles!.map((t) => [t.label, t.value])).toEqual([['Input', '0%'], ['Output', '9.1%'], ['Cache read', '82%'], ['Cache write', '9.1%']]);
    expect(mix.rows!.map((r) => [r.label, r.value])).toEqual([['m1', '667 output/request'], ['m2', '2,000 output/request']]);
    expect(mix.chart!.format).toBe('percent');
    const trend = await run('trend');
    expect(trend.summary).toBe('Output per request 1,000 → 1,000 (+0%) · cache hit 90% → 90%, from the earlier half of the range to the later');
    expect(trend.chart!.points.filter((p) => p.values['output']! > 0).map((p) => [p.ts - T0, p.values['output']])).toEqual([[0, 1_000], [20 * H, 1_000]]);
  });
});

describe('time profile (spec A10.8)', () => {
  const S = 1000;
  it('merges and subtracts intervals', () => {
    expect(merge([[5, 8], [0, 3], [2, 4], [8, 9]])).toEqual([[0, 4], [5, 9]]);
    expect(subtract([[0, 10], [20, 30]], [[2, 4], [8, 22], [25, 26]])).toEqual([[0, 2], [4, 8], [22, 25], [26, 30]]);
    expect(total([[0, 2], [5, 9]])).toBe(6);
    expect(toolClass('Bash')).toBe('local');
    expect(toolClass('mcp__github__get_pr')).toBe('network');
    expect(toolClass('Task')).toBe('nested');
  });

  it('keeps the tool name, duration and outcome of tool_result events, never their input', () => {
    const body = { resourceLogs: [{ resource: { attributes: [kv('devhost.account', 'business')] }, scopeLogs: [{ logRecords: [
      { timeUnixNano: String(BigInt(T0) * 1_000_000n), attributes: [kv('event.name', 'claude_code.tool_result'), kv('tool_name', 'Bash'), kv('duration_ms', 1500), kv('success', 'true'), kv('tool_input', 'rm -rf SECRET'), kv('session.id', 's1')] },
      { attributes: [kv('event.name', 'api_request'), kv('duration_ms', 900), kv('session.id', 's1')] },
    ] }] }] };
    const rows = parseToolRuns(body, T0, attribution());
    expect(rows).toEqual([{ ts: T0, account: 'business', env: '', sessionId: 's1', tool: 'Bash', durationMs: 1500, success: true }]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reads swap and memory pressure from sysctl', () => {
    expect(parseMemorySysctl('vm.swapusage: total = 10240.00M  used = 9427.25M  free = 812.75M  (encrypted)\nkern.memorystatus_vm_pressure_level: 2\n')).toEqual({ swapUsed: Math.round(9427.25 * 1024 ** 2), pressure: 2 });
  });

  function seeded(): Db {
    const db = new Db(':memory:');
    db.kvSet('profile_since', String(T0), T0);
    const api = (end: number, d: number) => db.run("INSERT INTO api_requests (ts, account, env, session_id, model, duration_ms) VALUES (?, 'business', 'acme-api', 's1', 'm', ?)", T0 + end * S, d * S);
    const tool = (end: number, d: number, name: string) => db.run("INSERT INTO tool_runs VALUES (?, 'business', 'acme-api', 's1', ?, ?, 1)", T0 + end * S, name, d * S);
    api(10, 10); // model 0–10
    tool(30, 20, 'Bash'); // local 10–30
    tool(28, 3, 'Read'); // local 25–28, parallel
    api(40, 12); // model 28–40
    tool(45, 5, 'WebFetch'); // network 40–45
    tool(45, 45, 'Task'); // the subagent's own requests count, not the Task itself
    for (const [t, cpu] of [[12, 90], [20, 10], [35, 95]] as const) db.run("INSERT INTO samples_session VALUES (?, 's1', ?, ?)", T0 + t * S, cpu, 2 * 1024 ** 3);
    db.run('INSERT INTO samples_system (ts, mem_pct, swap_used, mem_pressure) VALUES (?, 70, ?, 1), (?, 93, ?, 2)', T0 + 5 * S, 1024 ** 3, T0 + 15 * S, 3 * 1024 ** 3);
    return db;
  }

  it('splits agent time into model, local-only (CPU-bound part from samples) and network, the same raw and rolled up', () => {
    const db = seeded();
    const want = {
      since: T0,
      busyMs: 45 * S,
      modelMs: 22 * S,
      localMs: 20 * S,
      localOnlyMs: 18 * S, // 10–28: the Bash run while no request was in flight
      networkMs: 5 * S,
      cpuBoundMs: 9 * S, // one of the two samples taken then was busy
      tools: [
        { tool: 'Task', class: 'nested', runs: 1, ms: 45 * S },
        { tool: 'Bash', class: 'local', runs: 1, ms: 20 * S },
        { tool: 'WebFetch', class: 'network', runs: 1, ms: 5 * S },
        { tool: 'Read', class: 'local', runs: 1, ms: 3 * S },
      ],
      memory: { sessionPeakBytes: 2 * 1024 ** 3, systemPeakPercent: 93, swapPeakBytes: 3 * 1024 ** 3, pressureShare: 0.5 },
    };
    expect(buildProfile(db, T0 - H, T0 + 60 * S, {})).toEqual(want);
    rollup(db, T0 + 2 * H);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rollup_profile')!.n).toBe(1);
    expect(buildProfile(db, T0 - H, T0 + 2 * H, {})).toEqual(want);
    expect(buildProfile(db, T0 - H, T0 + 2 * H, { account: 'personal' })).toMatchObject({ busyMs: 0, tools: [] });
    expect(buildProfile(new Db(':memory:'), T0, T0 + H, {})).toBeNull(); // no tool runs yet
  });

  it('the stats plugin explains where the time went and how memory held up', async () => {
    const db = seeded();
    const dash = buildDash(db, CONFIG, { range: '24h' }, T0 + 60 * S, 'macmini', null);
    expect(validate('result.dash', dash).ok).toBe(true);
    const { stats: statsPlugin } = await import('../src/plugins/builtin/stats.js');
    const ctx = { stats: async () => dash } as unknown as PluginContext;
    const time = (await statsPlugin.widgets!.find((w) => w.id === 'time')!.run(ctx, { range: '24h' })) as WidgetContent;
    expect(time.summary).toBe('40% of agent time was spent waiting on this host, 20% of it CPU-bound');
    expect(time.tiles!.find((t) => t.label === '2× faster CPU')).toEqual({ label: '2× faster CPU', value: '−10%', sub: '4× faster: −15%' });
    const mem = (await statsPlugin.widgets!.find((w) => w.id === 'memory')!.run(ctx, { range: '24h' })) as WidgetContent;
    expect(mem).toMatchObject({ status: 'warn', summary: 'Under memory pressure 50% of the time' });
    expect(mem.tiles!.find((t) => t.label === 'Swap peak')!.value).toBe('3.0 GB');
  });
});

describe('handoff notes', () => {
  const NOTE = '## Goal\nShip it.\n';
  async function handing(over: { minutes?: number; ctx?: number; claude?: Partial<{ code: number; stdout: string }> } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'devhost-handoff-'));
    const cwd = join(home, 'work', 'business', 'acme-api');
    await mkdir(cwd, { recursive: true });
    const runner = new MockRunner().on(/claude -p --resume=/, over.claude ?? { stdout: NOTE });
    const config = parseConfig(
      `machine: { hostname: macmini }\nnotify: { topic: devhost-abcdefgh }\nclaude: { handoff: { idleMinutes: ${over.minutes ?? 55} } }\naccounts:\n  - { name: business, default: true, root: ${home}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }\nenvironments:\n  - { name: acme-api, account: business, portBase: 4100 }\n`,
      '/c',
    );
    const s = setup({ runner, config, home });
    const last = T0 - 56 * 60_000;
    s.db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at) VALUES ('sess-bbbb2222', 'business', 'acme-api', ?, 'idle', ?, ?)", cwd, T0 - 3 * H, last);
    s.db.run("INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source) VALUES (?, 'business', 'acme-api', 'sess-bbbb2222', 'claude-opus-5-5', 10, 100, ?, 1000, 0.5, 'main')", last - 1000, over.ctx ?? 120_000);
    const claudeCalls = () => runner.calls.filter((c) => c.args[0] === '-p');
    return { ...s, home, cwd, claudeCalls };
  }

  it('writes a note for a large session about to lose its cache, once, in its directory, with its model', async () => {
    const h = await handing();
    await h.collector.handoffTick();
    expect(h.claudeCalls()).toHaveLength(1);
    const call = h.claudeCalls()[0]!;
    expect(call.args).toEqual(expect.arrayContaining(['--resume=sess-bbbb2222', '--fork-session', '--no-session-persistence', '--model=claude-opus-5-5']));
    expect(call.opts?.cwd).toBe(h.cwd);
    expect(call.opts?.env?.OTEL_RESOURCE_ATTRIBUTES).toBe('devhost.account=business,devhost.env=acme-api');
    expect(await readFile(join(h.home, '.local/share/devhost/handoff/sess-bbbb2222.md'), 'utf8')).toBe(NOTE);
    expect(h.notifier.sent).toEqual([expect.objectContaining({ title: 'devhost: handoff note for acme-api', tags: ['memo'] })]);
    expect(h.notifier.sent[0]!.message).toContain('devhost session handoff sess-bbb');

    await h.collector.handoffTick();
    expect(h.claudeCalls()).toHaveLength(1);
    expect(buildDash(h.db, h.collector['config'], { range: '24h', home: h.home }, T0, 'm', null).sessions[0]).toMatchObject({ contextTokens: 121_010, handoffAt: expect.any(Number) });
  });

  it('leaves small, recent, long-gone sessions and turned-off notes alone', async () => {
    const small = await handing({ ctx: 1000 });
    await small.collector.handoffTick();
    expect(small.claudeCalls()).toEqual([]);

    const early = await handing();
    early.clock.now = T0 - 10 * 60_000;
    await early.collector.handoffTick();
    early.clock.now = T0 + 20 * 60_000;
    await early.collector.handoffTick();
    expect(early.claudeCalls()).toEqual([]);

    const off = await handing({ minutes: 0 });
    await off.collector.handoffTick();
    expect(off.claudeCalls()).toEqual([]);
  });

  it('does not retry a failed note until the session is active again', async () => {
    const h = await handing({ claude: { code: 1, stdout: '' } });
    await h.collector.handoffTick();
    await h.collector.handoffTick();
    expect(h.claudeCalls()).toHaveLength(1);
    expect(h.notifier.sent).toEqual([]);
    h.db.run("UPDATE sessions SET last_activity_at = ? WHERE session_id = 'sess-bbbb2222'", T0 - 55 * 60_000);
    await h.collector.handoffTick();
    expect(h.claudeCalls()).toHaveLength(2);
  });
});

describe('context habits', () => {
  it('counts requests over 300K and resumes after the cache expired, with their cost', () => {
    const db = new Db(':memory:');
    const req = (ts: number, session: string, read: number, write: number, cost: number) =>
      db.run("INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source) VALUES (?, 'business', 'acme-api', ?, 'm1', 10, 100, ?, ?, ?, 'main')", ts, session, read, write, cost);
    req(T0 - 5 * H, 's1', 100_000, 5_000, 0.2);
    req(T0 - 3 * H, 's1', 0, 105_000, 1.5); // two hours later: the cache was gone
    req(T0 - 2 * H, 's2', 310_000, 2_000, 0.6);
    req(T0 - 2 * H + 60_000, 's2', 312_000, 1_000, 0.6);
    const data = buildDash(db, CONFIG, { range: '24h' }, T0, 'm', null);
    expect(validate('result.dash', data).ok, JSON.stringify(validate('result.dash', data).issues)).toBe(true);
    expect(data.context).toMatchObject({ largeTokens: 300_000, mainRequests: 4, largeRequests: 2, largeCostUsd: 1.2, coldResumes: 1, coldCostUsd: 1.5 });
    expect(data.context!.mainCostUsd).toBeCloseTo(2.9);
    expect(data.context!.largeSessions).toEqual([expect.objectContaining({ id: 's2', contextTokens: 313_010 })]);
    expect(buildDash(new Db(':memory:'), CONFIG, { range: '24h' }, T0, 'm', null).context).toBeNull();
  });
});

describe('security and correctness fixes (collector review)', () => {
  const PROMPT = 'SECRET-PROMPT-TEXT-xyz';

  it('never puts a prompt-derived title in a notification or the stored snapshot (COL-1, COL-2)', async () => {
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    const home = await mkdtemp(join(tmpdir(), 'devhost-privacy-'));
    const cwd = join(home, 'work', 'business', 'acme-api');
    await mk(cwd, { recursive: true });
    const config = parseConfig(
      `machine: { hostname: macmini }\nnotify: { topic: devhost-abcdefgh }\nclaude: { handoff: { idleMinutes: 55 } }\naccounts:\n  - { name: business, default: true, root: ${home}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }\nenvironments:\n  - { name: acme-api, account: business, portBase: 4100 }\n`,
      '/c',
    );
    const runner = new MockRunner().on(/claude -p --resume=/, { stdout: '## Goal\n' });
    const s = setup({ runner, config, home });
    const dir = join(home, '.claude', 'projects', projectSlug(cwd));
    await mk(dir, { recursive: true });
    await wf(join(dir, 'sess-bbbb2222.jsonl'), `${JSON.stringify({ type: 'user', message: { content: PROMPT } })}\n`);
    const last = T0 - 56 * 60_000;
    s.db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at) VALUES ('sess-bbbb2222', 'business', 'acme-api', ?, 'idle', ?, ?)", cwd, T0 - 3 * H, last);
    s.db.run("INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, cache_read_tokens, cost_usd, source) VALUES (?, 'business', 'acme-api', 'sess-bbbb2222', 'm', 10, 120000, 0.5, 'main')", last - 1000);
    await s.collector.handoffTick();
    await s.collector.writeSnapshot();
    await s.collector.flushNotifications();
    expect(s.notifier.sent).toHaveLength(1);
    expect(JSON.stringify(s.notifier.sent)).not.toContain('SECRET');
    expect(s.notifier.sent[0]!.message).toContain('acme-api (sess-bbb');
    expect(s.db.kvGet('snapshot')).not.toContain('SECRET');
    expect(s.db.dumpText()).not.toContain('SECRET');
    // a real title is still shown
    await wf(join(dir, 'sess-bbbb2222.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Billing refactor' })}\n`);
    await s.collector.writeSnapshot();
    expect(s.db.kvGet('snapshot')).toContain('Billing refactor');
  });

  it('keeps a session mid-turn through a Notification, and maps waiting only for permission questions (COL-3)', () => {
    const db = new Db(':memory:');
    let now = T0;
    const ingest = new Ingestor(db, () => now, () => []);
    const row = () => db.get<{ state: string; turn_open: number; last_activity_at: number }>("SELECT state, turn_open, last_activity_at FROM sessions WHERE session_id = 's1'")!;
    ingest.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/x' }, 'a');
    expect(row()).toMatchObject({ state: 'running', turn_open: 1 });
    now += 1000;
    ingest.hook({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'idle_prompt' }, 'a');
    expect(row()).toMatchObject({ state: 'running', turn_open: 1, last_activity_at: T0 });
    ingest.hook({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt' }, 'a');
    expect(row()).toMatchObject({ state: 'waiting', turn_open: 1 });
    // telemetry from the session counts as activity
    now += 60_000;
    ingest.logs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [kv('event.name', 'api_request'), kv('session.id', 's1'), kv('model', 'm')] }] }] }] });
    expect(row().last_activity_at).toBe(now);
    ingest.hook({ hook_event_name: 'Stop', session_id: 's1', cwd: '/x' }, 'a');
    expect(row()).toMatchObject({ state: 'idle', turn_open: 0 });
  });

  it('does not sleep an environment or write a handoff note while a turn is open, even when state says waiting (COL-3)', async () => {
    const { handingOpen } = await (async () => {
      const home = await mkdtemp(join(tmpdir(), 'devhost-turn-'));
      const cwd = join(home, 'work', 'business', 'acme-api');
      await mkdir(cwd, { recursive: true });
      const runner = new MockRunner().on(/claude -p --resume=/, { stdout: 'note' });
      const config = parseConfig(`machine: { hostname: macmini }\nnotify: { topic: devhost-abcdefgh }\naccounts:\n  - { name: business, default: true, root: ${home}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }\nenvironments:\n  - { name: acme-api, account: business, portBase: 4100 }\n`, '/c');
      const s = setup({ runner, config, home });
      const last = T0 - 56 * 60_000;
      s.db.run("INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, turn_open) VALUES ('sess-cccc3333', 'business', 'acme-api', ?, 'waiting', ?, ?, 1)", cwd, T0 - 3 * H, last);
      s.db.run("INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, cache_read_tokens, cost_usd, source) VALUES (?, 'business', 'acme-api', 'sess-cccc3333', 'm', 10, 120000, 0.5, 'main')", last);
      return { handingOpen: { ...s, runner } };
    })();
    await handingOpen.collector.handoffTick();
    expect(handingOpen.runner.calls.filter((c) => c.args[0] === '-p')).toEqual([]);
  });

  it('refuses browsers, wrong Host, non-JSON content types, bad tokens and gzip bombs (COL-7)', async () => {
    const db = new Db(':memory:');
    const ingest = new Ingestor(db, () => T0, () => envLocations(CONFIG, HOME));
    const server = createCollectorServer(ingest, undefined, { token: 'tok-123' });
    await listen(server, 0);
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1/logs`;
    const auth = { Authorization: 'Bearer tok-123', 'Content-Type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers: auth, body: '{}' })).status).toBe(200);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' }, body: '{}' })).status).toBe(200);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/json' }, body: '{}' })).status).toBe(415);
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, Authorization: 'Bearer nope' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/hooks?token=tok-123`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Encoding': 'gzip' }, body: gzipSync(Buffer.alloc(9 * 1024 * 1024, 32)) })).status).toBe(413);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('only takes UUID-like session ids and never passes an odd one to claude (COL-7)', async () => {
    expect(parseHook({ hook_event_name: 'Stop', session_id: '--dangerous', cwd: '/x' })).toBeNull();
    expect(parseHook({ hook_event_name: 'Stop', session_id: '../x', cwd: '/x' })).toBeNull();
    expect(parseHook({ hook_event_name: 'Stop', session_id: 'x'.repeat(65), cwd: '/x' })).toBeNull();
    expect(parseHook({ hook_event_name: 'Stop', session_id: '3f2b8c1e-5d4a-4e7b-9a10-0c2f6b7d8e91', cwd: 'y'.repeat(5000) })?.cwd).toHaveLength(1024);
    const { writeHandoff } = await import('../src/handoff.js');
    const exec = {} as never;
    await expect(writeHandoff(exec, HOME, CONFIG, { session_id: '--model=x', account: 'business', env: 'e', cwd: '/' }, null)).rejects.toThrow('not a session id');
  });

  it('applies the 5 s timeout to ntfy requests (COL-8)', async () => {
    let signal: AbortSignal | undefined;
    await new NtfyNotifier('https://ntfy.sh', 't', async (_u, init) => {
      signal = init.signal;
      return { ok: true, status: 200 };
    }).send({ title: 'a', message: 'b' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('includes the usage of the part of an hour before the boundary in the 1h range (COL-4)', () => {
    const db = new Db(':memory:');
    const hour = new Date(2026, 9, 12, 10, 0, 0).getTime();
    const ins = (ts: number, v: number) => db.run("INSERT INTO usage (ts, account, env, session_id, model, kind, value) VALUES (?, 'a', 'e', 's', 'm', 'output', ?)", ts, v);
    ins(hour + 30 * 60_000, 7);
    ins(hour + 50 * 60_000, 11);
    ins(hour + 70 * 60_000, 13);
    const now = hour + 80 * 60_000; // 11:20: the 1h range starts at 10:20, inside a rolled-up hour
    rollup(db, now);
    const out = buildRange(db, { range: '1h' }, now).usage;
    expect(out.map((u) => [u.ts - hour, u.output])).toEqual([[30 * 60_000, 7], [50 * 60_000, 11], [70 * 60_000, 13]]);
  });

  it('rebuilds the notifier and re-arms the listener and timers when the config changes (COL-19)', async () => {
    const urls: string[] = [];
    const fetchImpl = async (u: string) => {
      urls.push(u);
      return { ok: true, status: 200 };
    };
    let cfg = parseConfig(`machine: { hostname: m }\nnotify: { topic: devhost-first01 }\ncollector: { port: 47318 }\naccounts:\n  - { name: business, default: true, root: ${HOME}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }\nenvironments: []\n`, '/c');
    const logs: string[] = [];
    const db = new Db(':memory:');
    const collector = new Collector({ db, config: () => cfg, deps: { home: HOME, user: 'op', brewPrefix: '/opt/homebrew', runner: new MockRunner() }, notifier: new NtfyNotifier('https://ntfy.sh', 'devhost-first01', fetchImpl), fetchImpl, now: () => T0, os: fakeOs().os, log: (m) => logs.push(m) });
    await collector.start();
    await collector['outbox'].send({ title: 't', message: 'm' });
    await collector.flushNotifications();
    cfg = parseConfig(`machine: { hostname: m }\nnotify: { topic: devhost-second2 }\ncollector: { port: 47318, sampleIntervalSeconds: 30 }\naccounts:\n  - { name: business, default: true, root: ${HOME}/work/business, portRange: [4000, 4999], git: { name: A, email: a@b.c } }\nenvironments: []\n`, '/c');
    await collector['outbox'].send({ title: 't', message: 'm' });
    await collector.flushNotifications();
    await collector.reloadIfChanged();
    await collector.stop();
    expect(urls).toEqual(['https://ntfy.sh/devhost-first01', 'https://ntfy.sh/devhost-second2']);
    expect(logs.some((l) => l.includes('re-arming'))).toBe(true);
  });
});

describe('collector token and service settings', () => {
  it('creates the token once, readable only by the user', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devhost-token-'));
    const t = collectorToken(home);
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(collectorToken(home)).toBe(t);
    expect(((await stat(tokenPath(home))).mode & 0o777).toString(8)).toBe('600');
  });

  it('puts a hash of the collector settings in the service plist, so apply restarts it on a change', async () => {
    const spec = async (yaml: string) => {
      const ctx = { config: parseConfig(`machine: { hostname: m }\nnotify: { topic: devhost-abcdefgh }\n${yaml}`, '/x'), home: '/h', nodePath: '/n', configPath: '/c' } as unknown as StepContext;
      return (await collectorSpec(ctx)).env['DEVHOST_COLLECTOR_SETTINGS'];
    };
    const a = await spec('collector: { port: 4318 }');
    expect(a).toBeTruthy();
    expect(await spec('collector: { port: 4318 }')).toBe(a);
    expect(await spec('collector: { port: 4319 }')).not.toBe(a);
    expect(await spec('collector: { port: 4318, sampleIntervalSeconds: 9 }')).not.toBe(a);
  });
});
