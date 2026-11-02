import type { DashData, DevhostConfig } from '@devhost/contract';
import { accountsOf, environmentsOf } from '../config/accounts.js';
import type { Db } from './db.js';
import { buildProfile } from './profile.js';
import { remoteSessionOf } from '../reattach.js';
import { handoffAt, lastMainRequest } from '../handoff.js';

export type Range = DashData['range'];
export const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

export interface DashOptions {
  range: Range;
  account?: string;
  env?: string;
  model?: string;
  /** The user's home: sessions then say when their handoff note was written. */
  home?: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RANGE_MS: Record<Range, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const BUCKET_MS: Record<Range, number> = { '1h': 5 * MIN, '24h': HOUR, '7d': 6 * HOUR, '30d': DAY };

export const KNOWN_LIMITS = [
  'Cost is an estimate reported by Claude Code. On a subscription it is API-equivalent value, not billed money.',
  'Subscription plan limits (session and weekly usage) are not part of the telemetry and are not shown.',
  'CPU and memory per session is best effort; per-environment numbers are reliable.',
  'Only this host is covered: cloud sessions and sessions on other machines are not included.',
];

const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheCreation'];

export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function localMonday(now: number): number {
  const d = new Date(localMidnight(now));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

interface UsageFilter {
  account?: string;
  env?: string;
  model?: string;
  sessionId?: string;
}

interface UsageAgg {
  t: number;
  account: string;
  session_id: string;
  kind: string;
  v: number;
}

/**
 * Usage from `from` on, grouped per time bucket, account, session and kind. Raw rows
 * cover everything since the last rollup, rollups cover the completed hours before it,
 * so nothing is counted twice (spec A10.3).
 */
function usage(db: Db, from: number, bucketMs: number, f: UsageFilter): UsageAgg[] {
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  const where: string[] = [];
  const params: (string | number)[] = [from, rolled, from, rolled];
  for (const [col, val] of [['account', f.account], ['env', f.env], ['model', f.model], ['session_id', f.sessionId]] as const) {
    if (val !== undefined && val !== '') {
      where.push(`${col} = ?`);
      params.push(val);
    }
  }
  return db.all<UsageAgg>(
    `SELECT (t / ${bucketMs}) * ${bucketMs} AS t, account, session_id, kind, SUM(value) AS v FROM (
       SELECT ts AS t, account, env, session_id, model, kind, value FROM usage WHERE ts >= ? AND ts >= ?
       UNION ALL
       SELECT hour AS t, account, env, session_id, model, kind, value FROM rollup_usage WHERE hour >= ? AND hour < ?
     ) ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY 1, account, session_id, kind`,
    ...params,
  );
}

const totals = (rows: UsageAgg[], pick: (r: UsageAgg) => boolean = () => true): { tokens: number; costUsd: number } => ({
  tokens: rows.filter((r) => pick(r) && TOKEN_KINDS.includes(r.kind)).reduce((a, r) => a + r.v, 0),
  costUsd: rows.filter((r) => pick(r) && r.kind === 'cost').reduce((a, r) => a + r.v, 0),
});

const recent = (ts: number | null | undefined, now: number, windowMs = MIN): boolean => ts != null && now - ts <= windowMs;

/** What depends on the time range: usage over time, agents at work, models, the time profile. */
export type RangeParts = Pick<DashData, 'range' | 'usage' | 'agents' | 'models' | 'profile' | 'sources' | 'context'>;
/** Everything else: the state now, what the collector precomputes every tick (kv `snapshot`). */
export type LiveParts = Omit<DashData, keyof RangeParts>;

/**
 * The range-dependent parts: rollups for completed hours plus the raw rows since the last rollup
 * (under an hour, read through the ts indexes): never a scan of the raw tables.
 */
export function buildRange(db: Db, opts: DashOptions, now: number): RangeParts {
  const bucketMs = BUCKET_MS[opts.range];
  const from = Math.floor((now - RANGE_MS[opts.range]) / bucketMs) * bucketMs;
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  const series = new Map<string, DashData['usage'][number]>();
  for (const r of usage(db, from, bucketMs, { account: opts.account, env: opts.env, model: opts.model })) {
    const key = `${r.t}|${r.account}`;
    const row = series.get(key) ?? { ts: r.t, account: r.account, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
    if (r.kind === 'input') row.input += r.v;
    else if (r.kind === 'output') row.output += r.v;
    else if (r.kind === 'cacheRead') row.cacheRead += r.v;
    else if (r.kind === 'cacheCreation') row.cacheCreation += r.v;
    else if (r.kind === 'cost') row.costUsd += r.v;
    series.set(key, row);
  }
  return {
    range: opts.range,
    usage: [...series.values()].sort((a, b) => a.ts - b.ts || a.account.localeCompare(b.account)),
    agents: agentConcurrency(db, opts.account ?? '', from, bucketMs, now),
    models: db.all<{ model: string }>(
      `SELECT DISTINCT model FROM (SELECT model FROM usage WHERE ts >= ? AND ts >= ? UNION ALL SELECT model FROM rollup_usage WHERE hour >= ? AND hour < ?) WHERE model <> '' ORDER BY model`,
      from, rolled, from, rolled,
    ).map((r) => r.model),
    profile: buildProfile(db, from, now, { account: opts.account, env: opts.env }),
    sources: sourcesOf(db, from, rolled, { account: opts.account, env: opts.env, model: opts.model }),
    context: contextOf(db, from, { account: opts.account, env: opts.env, model: opts.model }),
  };
}

/** A context this large makes every request expensive (spec A10.6): worth a /compact or a handoff. */
export const LARGE_CONTEXT_TOKENS = 300_000;
/** The prompt cache's lifetime: a session resumed later writes its whole context to the cache again. */
const CACHE_TTL_MS = HOUR;

/**
 * Context habits in the range, from the raw main-thread requests (older ones are rolled up without
 * their context): requests over a large context, and cold resumes, the first request more than an
 * hour after the session's previous one that wrote much of the context to the cache again.
 */
function contextOf(db: Db, from: number, f: { account?: string | undefined; env?: string | undefined; model?: string | undefined }): DashData['context'] {
  const where = ["source = 'main'", 'ts >= ?'];
  const params: (string | number)[] = [from - CACHE_TTL_MS];
  for (const [col, val] of [['account', f.account], ['env', f.env], ['model', f.model]] as const) {
    if (val !== undefined && val !== '') {
      where.push(`${col} = ?`);
      params.push(val);
    }
  }
  const rows = db.all<{ session_id: string; account: string; env: string; ts: number; prev: number | null; ctx: number; cc: number; cost: number }>(
    `SELECT session_id, account, env, ts, LAG(ts) OVER (PARTITION BY session_id ORDER BY ts) AS prev,
            COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0) AS ctx,
            COALESCE(cache_creation_tokens, 0) AS cc, COALESCE(cost_usd, 0) AS cost
       FROM api_requests WHERE ${where.join(' AND ')}`,
    ...params,
  ).filter((r) => r.ts >= from);
  if (rows.length === 0) return null;
  const out = { largeTokens: LARGE_CONTEXT_TOKENS, mainRequests: 0, mainCostUsd: 0, largeRequests: 0, largeCostUsd: 0, coldResumes: 0, coldCostUsd: 0 };
  const latest = new Map<string, { id: string; account: string; env: string; contextTokens: number; lastAt: number }>();
  for (const r of rows) {
    out.mainRequests++;
    out.mainCostUsd += r.cost;
    if (r.ctx >= LARGE_CONTEXT_TOKENS) {
      out.largeRequests++;
      out.largeCostUsd += r.cost;
    }
    // Most of a large context written again: not a few new tool results.
    if (r.prev !== null && r.ts - r.prev > CACHE_TTL_MS && r.cc >= 20_000 && r.cc >= r.ctx / 2) {
      out.coldResumes++;
      out.coldCostUsd += r.cost;
    }
    const cur = latest.get(r.session_id);
    if (!cur || r.ts >= cur.lastAt) latest.set(r.session_id, { id: r.session_id, account: r.account, env: r.env, contextTokens: Number(r.ctx), lastAt: Number(r.ts) });
  }
  const largeSessions = [...latest.values()].filter((x) => x.contextTokens >= LARGE_CONTEXT_TOKENS).sort((a, b) => b.contextTokens - a.contextTokens).slice(0, 10);
  return { ...out, largeSessions };
}

/** Tokens and cost by request source in the range, the largest cost first; null when no request carried one. */
function sourcesOf(db: Db, from: number, rolled: number, f: { account?: string | undefined; env?: string | undefined; model?: string | undefined }): DashData['sources'] {
  const where: string[] = [];
  const params: (string | number)[] = [from, rolled, from, rolled];
  for (const [col, val] of [['account', f.account], ['env', f.env], ['model', f.model]] as const) {
    if (val !== undefined && val !== '') {
      where.push(`${col} = ?`);
      params.push(val);
    }
  }
  const rows = db.all<{ source: string; requests: number; input: number; output: number; cache_read: number; cache_creation: number; cost: number }>(
    `SELECT source, SUM(requests) AS requests, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_creation) AS cache_creation, SUM(cost) AS cost FROM (
       SELECT account, env, source, model, 1 AS requests, COALESCE(input_tokens, 0) AS input, COALESCE(output_tokens, 0) AS output, COALESCE(cache_read_tokens, 0) AS cache_read, COALESCE(cache_creation_tokens, 0) AS cache_creation, COALESCE(cost_usd, 0) AS cost
         FROM api_requests WHERE ts >= ? AND ts >= ? AND source <> ''
       UNION ALL
       SELECT account, env, source, model, requests, input, output, cache_read, cache_creation, cost_usd FROM rollup_source WHERE hour >= ? AND hour < ?
     ) ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY source ORDER BY cost DESC, requests DESC`,
    ...params,
  );
  return rows.length === 0
    ? null
    : rows.map((r) => ({ source: r.source, requests: Number(r.requests), input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cache_read), cacheCreation: Number(r.cache_creation), costUsd: Number(r.cost) }));
}

/** A full snapshot for `devhost dash` and the desktop app (spec A10.6), computed now. */
export function buildDash(db: Db, config: DevhostConfig, opts: DashOptions, now: number, hostName: string, dbSizeBytes: number | null): DashData {
  return { ...buildLive(db, config, opts, now, hostName, dbSizeBytes), ...buildRange(db, opts, now) };
}

/**
 * The collector's precomputed snapshot (kv `snapshot`), or null without one. One the collector
 * stopped writing says the host is not online, as a computed one would.
 */
export function readSnapshot(db: Db, config: DevhostConfig, now: number): DashData | null {
  const v = db.kvGet('snapshot');
  if (!v) return null;
  try {
    const snap = JSON.parse(v) as DashData;
    const stale = now - snap.generatedAt > Math.max(MIN, (config.collector?.sampleIntervalSeconds ?? 5) * 3000);
    return stale ? { ...snap, host: { ...snap.host, online: false } } : snap;
  } catch {
    return null;
  }
}

/**
 * What `dash` and the plugins read: the collector's snapshot for the state now, and the range parts
 * from rollups. Filters (account, environment, model) and a missing snapshot (no collector yet, or
 * an older one) compute the whole snapshot instead.
 */
export function readDash(db: Db, config: DevhostConfig, opts: DashOptions, now: number, hostName: string, dbSizeBytes: number | null): DashData {
  const snap = opts.account || opts.env || opts.model ? null : readSnapshot(db, config, now);
  if (!snap) return buildDash(db, config, opts, now, hostName, dbSizeBytes);
  return { ...snap, ...(snap.range === opts.range ? {} : buildRange(db, opts, now)) };
}

/** The state now: host, collector, alerts, accounts, environments, sessions, volume, updates. */
export function buildLive(db: Db, config: DevhostConfig, opts: DashOptions, now: number, hostName: string, dbSizeBytes: number | null): LiveParts {
  const midnight = localMidnight(now);
  const sys = db.get<{ ts: number; cpu_pct: number | null; mem_pct: number | null; mem_total: number | null; disk_free_pct: number | null; disk_free_bytes: number | null }>('SELECT ts, cpu_pct, mem_pct, mem_total, disk_free_pct, disk_free_bytes FROM samples_system ORDER BY ts DESC LIMIT 1');
  const kvNum = (k: string): number | null => {
    const v = db.kvGet(k);
    return v === null ? null : Number(v);
  };

  let tailscale: DashData['host']['tailscale'] = null;
  const ts = db.kvGet('tailscale');
  if (ts && ts !== 'unavailable') {
    try {
      const t = JSON.parse(ts) as { state: string; dnsName: string | null };
      tailscale = { state: t.state, dnsName: t.dnsName ?? null };
    } catch {
      /* leave null */
    }
  }
  const dockerKv = db.kvGet('docker');

  const accounts = accountsOf(config).filter((a) => !opts.account || a.name === opts.account);
  // A bucket wider than the range collapses time, which is what totals need.
  const filter = { account: opts.account, env: opts.env, model: opts.model };
  const todayRows = usage(db, midnight, DAY * 365, filter);
  const weekRows = usage(db, localMonday(now), DAY * 365, filter);

  const sessionsRaw = db.all<{ session_id: string; account: string; env: string; cwd: string; state: string; started_at: number; last_activity_at: number }>(
    `SELECT session_id, account, env, cwd, state, started_at, last_activity_at FROM sessions
     WHERE (state <> 'ended' OR ended_at >= ?) AND (? = '' OR account = ?) AND (? = '' OR env = ?)
     ORDER BY last_activity_at DESC LIMIT 200`,
    midnight, opts.account ?? '', opts.account ?? '', opts.env ?? '', opts.env ?? '',
  );
  const sessionToday = new Map<string, { tokens: number; costUsd: number }>();
  for (const r of todayRows) {
    if (!r.session_id) continue;
    const cur = sessionToday.get(r.session_id) ?? { tokens: 0, costUsd: 0 };
    if (TOKEN_KINDS.includes(r.kind)) cur.tokens += r.v;
    if (r.kind === 'cost') cur.costUsd += r.v;
    sessionToday.set(r.session_id, cur);
  }

  const environments = environmentsOf(config)
    .filter((e) => (!opts.account || e.account === opts.account) && (!opts.env || e.name === opts.env))
    .map((e) => {
      const s = db.get<{ ts: number; cpu_pct: number | null; rss_bytes: number | null; container_cpu_pct: number | null; container_mem_bytes: number | null; service_pid: number | null }>(
        'SELECT ts, cpu_pct, rss_bytes, container_cpu_pct, container_mem_bytes, service_pid FROM samples_env WHERE account = ? AND env = ? ORDER BY ts DESC LIMIT 1',
        e.account, e.name,
      );
      const disk = db.get<{ bytes: number }>('SELECT bytes FROM env_disk WHERE account = ? AND env = ?', e.account, e.name);
      const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE account = ? AND env = ? AND state <> 'ended'", e.account, e.name)?.n ?? 0;
      const state: DashData['environments'][number]['service']['state'] =
        e.remoteControl?.enabled === false ? 'disabled' : !s || !recent(s.ts, now, 5 * MIN) ? 'unknown' : s.service_pid !== null ? 'running' : 'stopped';
      return {
        account: e.account,
        name: e.name,
        service: { state, pid: s?.service_pid ?? null },
        cpuPercent: s?.cpu_pct ?? null,
        rssBytes: s?.rss_bytes ?? null,
        containerCpuPercent: s?.container_cpu_pct ?? null,
        containerMemBytes: s?.container_mem_bytes ?? null,
        portBase: e.portBase ?? null,
        diskBytes: disk?.bytes ?? null,
        activeSessions: active,
      };
    });

  return {
    generatedAt: now,
    host: {
      name: hostName,
      online: recent(sys?.ts, now, Math.max(MIN, (config.collector?.sampleIntervalSeconds ?? 5) * 3000)),
      uptimeSeconds: kvNum('uptime_s'),
      cpuPercent: sys?.cpu_pct ?? null,
      memPercent: sys?.mem_pct ?? null,
      memTotalBytes: sys?.mem_total ?? null,
      diskFreePercent: sys?.disk_free_pct ?? null,
      diskFreeBytes: sys?.disk_free_bytes ?? null,
      docker: dockerKv === 'up' || dockerKv === 'down' ? dockerKv : 'unknown',
      tailscale,
    },
    collector: {
      lastSampleAt: sys?.ts ?? null,
      lastOtelAt: kvNum('last_otel_at'),
      lastHookAt: kvNum('last_hook_at'),
      dbSizeBytes,
      schemaVersion: db.schemaVersion,
    },
    alerts: db.all<{ id: string; message: string; since: number }>('SELECT id, message, since FROM alert_state WHERE active = 1 ORDER BY since'),
    accounts: accounts.map((a) => {
      const auth = db.kvGet(`auth:${a.name}`);
      return {
        name: a.name,
        loggedIn: auth === null ? null : auth === 'ok',
        lastAuthCheckAt: kvNum(`auth_checked:${a.name}`),
        today: totals(todayRows, (r) => r.account === a.name),
        week: totals(weekRows, (r) => r.account === a.name),
        dailyCostAlertUsd: a.alerts?.dailyCostUsd ?? null,
      };
    }),
    environments,
    sessions: sessionsRaw.map((s) => {
      const live = db.get<{ ts: number; cpu_pct: number | null; rss_bytes: number | null }>('SELECT ts, cpu_pct, rss_bytes FROM samples_session WHERE session_id = ? ORDER BY ts DESC LIMIT 1', s.session_id);
      const fresh = live && recent(live.ts, now, 2 * MIN) && s.state !== 'ended';
      const today = sessionToday.get(s.session_id) ?? { tokens: 0, costUsd: 0 };
      return {
        id: s.session_id,
        account: s.account || null,
        env: s.env || null,
        state: s.state as DashData['sessions'][number]['state'],
        startedAt: s.started_at,
        lastActivityAt: s.last_activity_at,
        tokensToday: today.tokens,
        costToday: today.costUsd,
        cpuPercent: fresh ? live.cpu_pct : null,
        rssBytes: fresh ? live.rss_bytes : null,
        subagents: subagentsOf(db, s.session_id),
        remoteSession: remoteSessionOf(s.cwd)?.id ?? null,
        contextTokens: lastMainRequest(db, s.session_id)?.contextTokens ?? null,
        handoffAt: opts.home ? handoffAt(opts.home, s.session_id) : null,
      };
    }),
    limits: KNOWN_LIMITS,
    volume: volumeOf(db, config),
    updates: config.claude?.update === 'off' ? null : (JSON.parse(db.kvGet('update') ?? 'null') as DashData['updates']),
  };
}

/** The work volume as last sampled (null without one, or before the first sample). */
function volumeOf(db: Db, config: DevhostConfig): DashData['volume'] {
  if (!config.storage?.workVolume) return null;
  const row = db.get<{ value: string; updated_at: number }>("SELECT value, updated_at FROM kv WHERE key = 'volume'");
  if (!row) return null;
  const v = JSON.parse(row.value) as Record<string, unknown>;
  return {
    label: String(v['label']), mountPoint: String(v['mountPoint']), root: String(v['root']), ready: v['ready'] === true, mounted: v['mounted'] === true,
    encrypted: (v['encrypted'] as boolean | null) ?? null, locked: (v['locked'] as boolean | null) ?? null,
    totalBytes: (v['totalBytes'] as number | null) ?? null, freeBytes: (v['freeBytes'] as number | null) ?? null, freePct: (v['freePct'] as number | null) ?? null,
    freeLimit: Number(v['freeLimit'] ?? 15), doubleMount: v['doubleMount'] === true, strayDirectory: v['strayDirectory'] === true, sampledAt: row.updated_at,
  };
}

function subagentsOf(db: Db, sessionId: string): NonNullable<DashData['sessions'][number]['subagents']> {
  const rows = db.all<{ agent_type: string; running: number }>('SELECT agent_type, CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END AS running FROM agents WHERE session_id = ?', sessionId);
  return {
    running: rows.filter((r) => Number(r.running) === 1).length,
    total: rows.length,
    types: [...new Set(rows.map((r) => r.agent_type).filter(Boolean))].sort(),
  };
}

/**
 * Agents at work at once, per bucket: the highest sample in it (raw samples, and hourly rollups
 * for what retention already dropped). `account` '' is all accounts together.
 */
function agentConcurrency(db: Db, account: string, from: number, bucketMs: number, now: number): NonNullable<DashData['agents']> {
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  const buckets = db
    .all<{ ts: number; sessions: number; subagents: number; total: number }>(
      `SELECT (t / ${bucketMs}) * ${bucketMs} AS ts, MAX(s) AS sessions, MAX(a) AS subagents, MAX(n) AS total FROM (
         SELECT ts AS t, sessions AS s, subagents AS a, sessions + subagents AS n FROM samples_agents WHERE account = ? AND ts >= ?
         UNION ALL
         SELECT hour AS t, sessions_max AS s, subagents_max AS a, total_max AS n FROM rollup_agents WHERE account = ? AND hour >= ?
           AND hour < ?
       ) GROUP BY 1 ORDER BY 1`,
      account, Math.max(from, rolled), account, from, rolled,
    )
    .map((r) => ({ ts: Number(r.ts), sessions: Number(r.sessions), subagents: Number(r.subagents), total: Number(r.total) }));
  const latest = db.get<{ ts: number; sessions: number; subagents: number }>('SELECT ts, sessions, subagents FROM samples_agents WHERE account = ? ORDER BY ts DESC LIMIT 1', account);
  const fresh = latest && now - latest.ts < 2 * MIN;
  const peak = buckets.reduce<{ total: number; at: number | null }>((p, b) => (b.total > p.total ? { total: b.total, at: b.ts } : p), { total: 0, at: null });
  return { now: { sessions: fresh ? Number(latest.sessions) : 0, subagents: fresh ? Number(latest.subagents) : 0 }, peak, buckets };
}

