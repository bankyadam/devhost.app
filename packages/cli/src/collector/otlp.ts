/**
 * Minimal OTLP/HTTP JSON receiver logic (spec A10.1). Pure functions: bytes in, rows out.
 * Metric and event names are the ones documented for Claude Code monitoring.
 */

export interface UsageRow {
  ts: number;
  account: string;
  env: string;
  sessionId: string;
  model: string;
  kind: string;
  value: number;
}

export interface ApiRequestRow {
  ts: number;
  account: string;
  env: string;
  sessionId: string;
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Where the request came from, see `sourceOf`; '' when Claude Code did not say. */
  source: string;
}

/**
 * Claude Code's `query_source` as one short label: the main thread, a built-in subagent type
 * (`agent:builtin:Explore` → `Explore`), `custom agents` (the name of a custom agent is not reported),
 * compaction, anything else as it is.
 */
export function sourceOf(q: string): string {
  if (q === '') return '';
  if (q.startsWith('repl_main_thread') || q === 'sdk') return 'main';
  if (q.startsWith('agent:builtin:')) return q.slice('agent:builtin:'.length) || 'builtin agent';
  if (q.startsWith('agent:custom')) return 'custom agents';
  if (q === 'compact') return 'compaction';
  return q.slice(0, 60);
}

type Attrs = Record<string, string | number | boolean>;

interface KeyValue {
  key: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
}

export function attrsOf(list: KeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of list ?? []) {
    const v = kv.value;
    if (!v) continue;
    if (v.stringValue !== undefined) out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[kv.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[kv.key] = v.boolValue;
  }
  return out;
}

/** Attribute values are capped: a sender can put anything in them. */
const str = (a: Attrs, k: string): string => (a[k] === undefined ? '' : String(a[k]).slice(0, 256));
const num = (a: Attrs, k: string): number | null => {
  const v = a[k];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const nanoToMs = (n: string | number | undefined, fallback: number): number => {
  if (n === undefined) return fallback;
  const ms = Number(BigInt(String(n).split('.')[0] ?? '0') / 1_000_000n);
  return ms > 0 ? ms : fallback;
};

/** Identity of a datapoint, used to turn cumulative counters into deltas. */
export class CumulativeTracker {
  private readonly last = new Map<string, number>();
  delta(key: string, value: number): number {
    const prev = this.last.get(key);
    this.last.set(key, value);
    if (prev === undefined) return value;
    return value >= prev ? value - prev : value; // a drop means the counter restarted
  }
}

export interface Attribution {
  /** email → account, learned from datapoints that also carry devhost.account. */
  emailToAccount(email: string): string | undefined;
  learn(email: string, account: string): void;
  /**
   * The account whose login sent this, from `claude auth status` (organization id, else an email
   * only one account uses). It wins over devhost.account, which only says which config directory
   * the process read: the Claude app's own Claude Code reads ~/.claude whatever account it is
   * signed in with.
   */
  ownerOf?(orgId: string, email: string): string | undefined;
  /** A session whose owner is known, so its hook-based session row can follow. */
  claim?(sessionId: string, account: string): void;
}

function attribute(resource: Attrs, point: Attrs, attr: Attribution): { account: string; env: string } {
  const email = str(point, 'user.email') || str(resource, 'user.email');
  const org = str(point, 'organization.id') || str(resource, 'organization.id');
  const owner = org || email ? attr.ownerOf?.(org, email) : undefined;
  let account = str(resource, 'devhost.account') || str(point, 'devhost.account');
  if (owner) {
    account = owner;
    const session = str(point, 'session.id') || str(resource, 'session.id');
    if (session) attr.claim?.(session, owner);
  } else {
    if (account && email) attr.learn(email, account);
    if (!account && email) account = attr.emailToAccount(email) ?? '';
  }
  return { account, env: str(resource, 'devhost.env') || str(point, 'devhost.env') };
}

interface DataPoint {
  attributes?: KeyValue[];
  timeUnixNano?: string | number;
  asDouble?: number;
  asInt?: string | number;
}
interface Metric {
  name: string;
  sum?: { dataPoints?: DataPoint[]; aggregationTemporality?: number | string };
  gauge?: { dataPoints?: DataPoint[] };
}
interface MetricsBody {
  resourceMetrics?: { resource?: { attributes?: KeyValue[] }; scopeMetrics?: { metrics?: Metric[] }[] }[];
}

const isCumulative = (t: number | string | undefined): boolean => t === 2 || (typeof t === 'string' && /CUMULATIVE/i.test(t));

function kindsFor(name: string, point: Attrs): string[] {
  switch (name.replace(/^claude_code\./, '')) {
    case 'token.usage':
      return [str(point, 'type') || 'input'];
    case 'cost.usage':
      return ['cost'];
    case 'session.count':
      return ['sessions'];
    case 'lines_of_code.count':
      return [str(point, 'type') === 'removed' ? 'lines_removed' : 'lines_added'];
    case 'commit.count':
      return ['commits'];
    case 'pull_request.count':
      return ['prs'];
    case 'active_time.total':
      return [str(point, 'type') === 'user' ? 'active_user_s' : 'active_cli_s'];
    default:
      return [];
  }
}

export function parseMetrics(body: unknown, now: number, tracker: CumulativeTracker, attr: Attribution): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const rm of (body as MetricsBody).resourceMetrics ?? []) {
    const resource = attrsOf(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        const cumulative = isCumulative(metric.sum?.aggregationTemporality);
        for (const dp of metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []) {
          const point = attrsOf(dp.attributes);
          const raw = dp.asDouble ?? Number(dp.asInt ?? 0);
          if (!Number.isFinite(raw)) continue;
          const { account, env } = attribute(resource, point, attr);
          for (const kind of kindsFor(metric.name, point)) {
            const key = [metric.name, account, env, str(point, 'session.id'), str(point, 'model'), kind].join('|');
            const value = cumulative ? tracker.delta(key, raw) : raw;
            if (value === 0) continue;
            rows.push({ ts: nanoToMs(dp.timeUnixNano, now), account, env, sessionId: str(point, 'session.id'), model: str(point, 'model'), kind, value });
          }
        }
      }
    }
  }
  return rows;
}

interface LogsBody {
  resourceLogs?: { resource?: { attributes?: KeyValue[] }; scopeLogs?: { logRecords?: { timeUnixNano?: string | number; attributes?: KeyValue[] }[] }[] }[];
}

/** `api_request` events only: they carry token counts and cost, never prompt text. */
export function parseLogs(body: unknown, now: number, attr: Attribution): ApiRequestRow[] {
  const rows: ApiRequestRow[] = [];
  for (const rl of (body as LogsBody).resourceLogs ?? []) {
    const resource = attrsOf(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const a = attrsOf(rec.attributes);
        const name = str(a, 'event.name').replace(/^claude_code\./, '');
        if (name !== 'api_request') continue;
        const { account, env } = attribute(resource, a, attr);
        rows.push({
          ts: nanoToMs(rec.timeUnixNano, now),
          account,
          env,
          sessionId: str(a, 'session.id'),
          model: str(a, 'model'),
          input: num(a, 'input_tokens'),
          output: num(a, 'output_tokens'),
          cacheRead: num(a, 'cache_read_tokens'),
          cacheCreation: num(a, 'cache_creation_tokens'),
          costUsd: num(a, 'cost_usd'),
          durationMs: num(a, 'duration_ms'),
          source: sourceOf(str(a, 'query_source')),
        });
      }
    }
  }
  return rows;
}

export interface ToolRunRow {
  ts: number;
  account: string;
  env: string;
  sessionId: string;
  tool: string;
  durationMs: number;
  success: boolean | null;
}

/** `tool_result` events: the tool's name, how long it ran and whether it worked; never its input or output. */
export function parseToolRuns(body: unknown, now: number, attr: Attribution): ToolRunRow[] {
  const rows: ToolRunRow[] = [];
  for (const rl of (body as LogsBody).resourceLogs ?? []) {
    const resource = attrsOf(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const a = attrsOf(rec.attributes);
        if (str(a, 'event.name').replace(/^claude_code\./, '') !== 'tool_result') continue;
        const duration = num(a, 'duration_ms');
        if (duration === null) continue;
        const { account, env } = attribute(resource, a, attr);
        const success = str(a, 'success');
        rows.push({ ts: nanoToMs(rec.timeUnixNano, now), account, env, sessionId: str(a, 'session.id'), tool: str(a, 'tool_name').slice(0, 120) || '?', durationMs: duration, success: success === '' ? null : success === 'true' });
      }
    }
  }
  return rows;
}
