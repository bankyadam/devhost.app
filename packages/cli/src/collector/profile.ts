import type { DashData } from '@devhost/contract';
import type { Db } from './db.js';

const HOUR = 3_600_000;

/**
 * Where agents spend their time (spec A10.8). Each `api_request` and `tool_result` event ends at its
 * timestamp and lasted `duration_ms`. Per session the intervals are merged (parallel subagents and
 * tools count once), then:
 * - model: the API requests (Anthropic's side; a faster host does not change it),
 * - local: tools that run on this host (Bash, Read, Edit, Grep…),
 * - network: tools that wait on another service (WebFetch, WebSearch, MCP),
 * - local only: local tool time with nothing else running in the session: what a faster host could
 *   shorten. Its CPU-bound part is estimated from the session's process-tree CPU samples taken then.
 */
export type ToolClass = 'local' | 'network' | 'wait' | 'nested';

const NETWORK = new Set(['WebFetch', 'WebSearch']);
const WAIT = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'ScheduleWakeup', 'Monitor']);
const NESTED = new Set(['Task', 'Agent']);

export function toolClass(tool: string): ToolClass {
  if (NESTED.has(tool)) return 'nested';
  if (WAIT.has(tool)) return 'wait';
  if (NETWORK.has(tool) || tool.startsWith('mcp__')) return 'network';
  return 'local';
}

/** A session's process tree using at least this much of one core counts as CPU-bound. */
export const CPU_BOUND_PERCENT = 50;

type Iv = [number, number];

export function merge(ivs: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const [a, b] of [...ivs].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export const total = (ivs: Iv[]): number => ivs.reduce((s, [a, b]) => s + (b - a), 0);

/** Merged `a` minus merged `b`. */
export function subtract(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const [s, e] of a) {
    let cur = s;
    for (const [bs, be] of b) {
      if (be <= cur || bs >= e) continue;
      if (bs > cur) out.push([cur, bs]);
      cur = Math.max(cur, be);
      if (cur >= e) break;
    }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}

const inside = (ivs: Iv[], t: number): boolean => ivs.some(([a, b]) => t >= a && t < b);

export interface ProfileRow {
  account: string;
  env: string;
  busyMs: number;
  modelMs: number;
  localMs: number;
  localOnlyMs: number;
  networkMs: number;
  /** CPU samples of sessions taken in local-only time, and how many of them were CPU-bound. */
  localSamples: number;
  localBusySamples: number;
  /** Highest process-tree RSS of one session. */
  rssPeak: number;
}

export interface ToolRow {
  account: string;
  env: string;
  tool: string;
  runs: number;
  ms: number;
}

/** When tool runs started to be recorded (null: not yet). Earlier time has API requests only. */
export const profileSince = (db: Db): number | null => {
  const v = db.kvGet('profile_since');
  return v === null ? null : Number(v);
};

/** The profile of [from, to) per account and environment, from raw events and samples. */
export function profileWindow(db: Db, windowFrom: number, to: number): { rows: ProfileRow[]; tools: ToolRow[] } {
  const since = profileSince(db);
  if (since === null || since >= to) return { rows: [], tools: [] };
  const from = Math.max(windowFrom, since);
  // An event is stored when it ends: one ending up to an hour later may have started in the window.
  const api = db.all<{ ts: number; account: string; env: string; session_id: string; d: number }>(
    'SELECT ts, account, env, session_id, COALESCE(duration_ms, 0) AS d FROM api_requests WHERE ts >= ? AND ts < ?', from, to + HOUR,
  );
  const tools = db.all<{ ts: number; account: string; env: string; session_id: string; tool: string; d: number }>(
    'SELECT ts, account, env, session_id, tool, duration_ms AS d FROM tool_runs WHERE ts >= ? AND ts < ?', from, to + HOUR,
  );
  const clip = (ts: number, d: number): Iv => [Math.max(ts - d, from), Math.min(ts, to)];
  type S = { account: string; env: string; model: Iv[]; local: Iv[]; network: Iv[] };
  const sessions = new Map<string, S>();
  const of = (id: string, account: string, env: string): S => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { account, env, model: [], local: [], network: [] }));
    return s;
  };
  for (const r of api) of(r.session_id, r.account, r.env).model.push(clip(r.ts, r.d));
  const byTool = new Map<string, ToolRow>();
  for (const r of tools) {
    const cls = toolClass(r.tool);
    const iv = clip(r.ts, r.d);
    if (cls === 'local') of(r.session_id, r.account, r.env).local.push(iv);
    else if (cls === 'network') of(r.session_id, r.account, r.env).network.push(iv);
    if (r.ts < from || r.ts >= to) continue;
    const key = `${r.account}\0${r.env}\0${r.tool}`;
    const t = byTool.get(key) ?? { account: r.account, env: r.env, tool: r.tool, runs: 0, ms: 0 };
    t.runs++;
    t.ms += r.d;
    byTool.set(key, t);
  }

  const rows = new Map<string, ProfileRow>();
  for (const [id, s] of sessions) {
    const model = merge(s.model);
    const local = merge(s.local);
    const network = merge(s.network);
    const other = merge([...model, ...network]);
    const busy = merge([...other, ...local]);
    const localOnly = subtract(local, other);
    const key = `${s.account}\0${s.env}`;
    const r = rows.get(key) ?? { account: s.account, env: s.env, busyMs: 0, modelMs: 0, localMs: 0, localOnlyMs: 0, networkMs: 0, localSamples: 0, localBusySamples: 0, rssPeak: 0 };
    r.busyMs += total(busy);
    r.modelMs += total(model);
    r.localMs += total(local);
    r.localOnlyMs += total(localOnly);
    r.networkMs += total(network);
    if (localOnly.length > 0) {
      for (const smp of db.all<{ ts: number; cpu_pct: number | null }>('SELECT ts, cpu_pct FROM samples_session WHERE session_id = ? AND ts >= ? AND ts < ?', id, from, to)) {
        if (smp.cpu_pct == null || !inside(localOnly, smp.ts)) continue;
        r.localSamples++;
        if (smp.cpu_pct >= CPU_BOUND_PERCENT) r.localBusySamples++;
      }
    }
    r.rssPeak = Math.max(r.rssPeak, db.get<{ m: number | null }>('SELECT MAX(rss_bytes) AS m FROM samples_session WHERE session_id = ? AND ts >= ? AND ts < ?', id, from, to)?.m ?? 0);
    rows.set(key, r);
  }
  return { rows: [...rows.values()].filter((r) => r.busyMs > 0), tools: [...byTool.values()] };
}

/** System memory in [from, to): peak use, peak swap, and samples under memory pressure. */
export function memoryWindow(db: Db, from: number, to: number): { memPctMax: number | null; memPctAvg: number | null; swapMax: number | null; pressureSamples: number; samples: number } {
  const r = db.get<{ mx: number | null; av: number | null; sw: number | null; pr: number | null; n: number }>(
    'SELECT MAX(mem_pct) AS mx, AVG(mem_pct) AS av, MAX(swap_used) AS sw, SUM(CASE WHEN mem_pressure >= 2 THEN 1 ELSE 0 END) AS pr, COUNT(*) AS n FROM samples_system WHERE ts >= ? AND ts < ?', from, to,
  );
  return { memPctMax: r?.mx ?? null, memPctAvg: r?.av ?? null, swapMax: r?.sw ?? null, pressureSamples: r?.pr ?? 0, samples: r?.n ?? 0 };
}

/** Roll the completed hours [from, upTo) into rollup_profile, rollup_tools and rollup_memory. */
export function rollupProfile(db: Db, from: number, upTo: number): void {
  // Nothing before tool runs were recorded (and the first rollup would otherwise walk every hour since 1970).
  const first = profileSince(db);
  if (first == null) return;
  for (let h = Math.max(from, Math.floor(first / HOUR) * HOUR); h < upTo; h += HOUR) {
    const { rows, tools } = profileWindow(db, h, h + HOUR);
    for (const r of rows) {
      db.run(
        `INSERT OR REPLACE INTO rollup_profile (hour, account, env, busy_ms, model_ms, local_ms, local_only_ms, network_ms, local_samples, local_busy_samples, rss_peak)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        h, r.account, r.env, r.busyMs, r.modelMs, r.localMs, r.localOnlyMs, r.networkMs, r.localSamples, r.localBusySamples, r.rssPeak,
      );
    }
    for (const t of tools) db.run('INSERT OR REPLACE INTO rollup_tools (hour, account, env, tool, runs, ms) VALUES (?, ?, ?, ?, ?, ?)', h, t.account, t.env, t.tool, t.runs, t.ms);
    const m = memoryWindow(db, h, h + HOUR);
    if (m.samples > 0) {
      db.run('INSERT OR REPLACE INTO rollup_memory (hour, mem_pct_max, mem_pct_avg, swap_max, pressure_samples, samples) VALUES (?, ?, ?, ?, ?, ?)', h, m.memPctMax, m.memPctAvg, m.swapMax, m.pressureSamples, m.samples);
    }
  }
}

/** The profile for the dashboard: rolled-up hours, plus raw data since the last rollup. */
export function buildProfile(db: Db, rangeFrom: number, now: number, filter: { account?: string | undefined; env?: string | undefined }): DashData['profile'] {
  const since = profileSince(db);
  if (since === null) return null;
  const from = Math.max(rangeFrom, Math.floor(since / HOUR) * HOUR);
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  const rawFrom = Math.max(from, rolled);
  const keep = (r: { account: string; env: string }): boolean => (!filter.account || r.account === filter.account) && (!filter.env || r.env === filter.env);

  const rows: ProfileRow[] = db
    .all<{ account: string; env: string; busy_ms: number; model_ms: number; local_ms: number; local_only_ms: number; network_ms: number; local_samples: number; local_busy_samples: number; rss_peak: number }>(
      'SELECT * FROM rollup_profile WHERE hour >= ? AND hour < ?', from, rolled,
    )
    .map((r) => ({ account: r.account, env: r.env, busyMs: r.busy_ms, modelMs: r.model_ms, localMs: r.local_ms, localOnlyMs: r.local_only_ms, networkMs: r.network_ms, localSamples: r.local_samples, localBusySamples: r.local_busy_samples, rssPeak: r.rss_peak }));
  const toolRows: ToolRow[] = db.all<ToolRow>('SELECT account, env, tool, runs, ms FROM rollup_tools WHERE hour >= ? AND hour < ?', from, rolled);
  if (rawFrom < now) {
    const raw = profileWindow(db, rawFrom, now);
    rows.push(...raw.rows);
    toolRows.push(...raw.tools);
  }
  const mine = rows.filter(keep);
  const sum = (k: keyof ProfileRow): number => mine.reduce((s, r) => s + (r[k] as number), 0);
  const samples = sum('localSamples');
  const localOnlyMs = sum('localOnlyMs');
  const toolTotals = new Map<string, { runs: number; ms: number }>();
  for (const t of toolRows.filter(keep)) {
    const cur = toolTotals.get(t.tool) ?? { runs: 0, ms: 0 };
    toolTotals.set(t.tool, { runs: cur.runs + t.runs, ms: cur.ms + t.ms });
  }

  const memRolled = db.get<{ mx: number | null; sw: number | null; pr: number | null; n: number | null }>(
    'SELECT MAX(mem_pct_max) AS mx, MAX(swap_max) AS sw, SUM(pressure_samples) AS pr, SUM(samples) AS n FROM rollup_memory WHERE hour >= ? AND hour < ?', from, rolled,
  );
  const memRaw = rawFrom < now ? memoryWindow(db, rawFrom, now) : null;
  const memSamples = (memRolled?.n ?? 0) + (memRaw?.samples ?? 0);
  const maxOf = (...xs: (number | null | undefined)[]): number | null => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? Math.max(...v) : null;
  };

  return {
    since,
    busyMs: sum('busyMs'),
    modelMs: sum('modelMs'),
    localMs: sum('localMs'),
    localOnlyMs,
    networkMs: sum('networkMs'),
    cpuBoundMs: samples > 0 ? Math.round((localOnlyMs * sum('localBusySamples')) / samples) : null,
    tools: [...toolTotals].map(([tool, t]) => ({ tool, class: toolClass(tool), runs: t.runs, ms: t.ms })).sort((a, b) => b.ms - a.ms).slice(0, 12),
    memory: {
      sessionPeakBytes: mine.length ? Math.max(...mine.map((r) => r.rssPeak)) || null : null,
      systemPeakPercent: maxOf(memRolled?.mx, memRaw?.memPctMax),
      swapPeakBytes: maxOf(memRolled?.sw, memRaw?.swapMax),
      pressureShare: memSamples > 0 ? ((memRolled?.pr ?? 0) + (memRaw?.pressureSamples ?? 0)) / memSamples : null,
    },
  };
}
