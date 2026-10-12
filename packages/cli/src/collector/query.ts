import type { DashData, DevhostConfig } from '@devhost/contract';
import { accountsOf, environmentsOf } from '../config/accounts.js';
import type { Db } from './db.js';

export type Range = DashData['range'];
export const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

export interface DashOptions {
  range: Range;
  account?: string;
  env?: string;
  model?: string;
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
  'Only this Mac mini is covered: cloud sessions and sessions on other machines are not included.',
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

/** Snapshot for `devhost dash` and the desktop app (spec A10.6). */
export function buildDash(db: Db, config: DevhostConfig, opts: DashOptions, now: number, hostName: string, dbSizeBytes: number | null): DashData {
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
      tailscale = JSON.parse(ts) as NonNullable<DashData['host']['tailscale']>;
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

  const sessionsRaw = db.all<{ session_id: string; account: string; env: string; state: string; started_at: number; last_activity_at: number }>(
    `SELECT session_id, account, env, state, started_at, last_activity_at FROM sessions
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

  const bucketMs = BUCKET_MS[opts.range];
  const from = Math.floor((now - RANGE_MS[opts.range]) / bucketMs) * bucketMs;
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
    generatedAt: now,
    range: opts.range,
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
      };
    }),
    usage: [...series.values()].sort((a, b) => a.ts - b.ts || a.account.localeCompare(b.account)),
    limits: KNOWN_LIMITS,
  };
}
