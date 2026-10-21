import type { DashData } from '@devhost/contract';
import { definePlugin, type PluginContext, type StatsQuery, type WidgetCard, type WidgetChart, type WidgetContent } from '../api.js';

/**
 * stats: the dashboard's usage statistics, as a plugin (built in; `plugins.stats.enabled: false`
 * turns it off). Filters (range, account, environment, model, metric, stacking), a card per account
 * (today, this week, the daily cost alert), tokens or cost over time, and agents at work. It reads
 * the collector's data through `ctx.stats` only, like any plugin could.
 */

type Range = DashData['range'];
type Row = DashData['usage'][number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BUCKET_MS: Record<Range, number> = { '1h': 5 * MIN, '24h': HOUR, '7d': 6 * HOUR, '30d': DAY };
const RANGE_MS: Record<Range, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const PER: Record<Range, string> = { '1h': '5 minutes', '24h': 'hour', '7d': '6 hours', '30d': 'day' };
const RANGES: { value: Range; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
const TOKEN_TYPES = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheCreation', label: 'Cache write' },
] as const;
const REFRESH = 15;

const trim = (n: number): string => (n >= 100 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
export function compact(v: number): string {
  if (v >= 1e9) return `${trim(v / 1e9)}B`;
  if (v >= 1e6) return `${trim(v / 1e6)}M`;
  if (v >= 1e4) return `${trim(v / 1e3)}K`;
  return Math.round(v).toLocaleString('en-US');
}
const usd = (v: number): string => `$${v.toFixed(v >= 100 ? 0 : 2)}`;

function query(p: Record<string, string>): StatsQuery {
  const range = (RANGES.some((r) => r.value === p['range']) ? p['range'] : '24h') as Range;
  return { range, ...(p['account'] ? { account: p['account'] } : {}), ...(p['env'] ? { env: p['env'] } : {}), ...(p['model'] ? { model: p['model'] } : {}) };
}

/** The range's column starts, oldest first (empty ones count as zero, so gaps show). */
function columns(d: DashData): number[] {
  const size = BUCKET_MS[d.range];
  const end = Math.floor(d.generatedAt / size) * size;
  const out: number[] = [];
  for (let t = Math.floor((d.generatedAt - RANGE_MS[d.range]) / size) * size + size; t <= end; t += size) out.push(t);
  return out;
}

const rowValue = (r: Row, metric: string): number => (metric === 'cost' ? r.costUsd : r.input + r.output + r.cacheRead + r.cacheCreation);

export function usageChart(d: DashData, metric: 'tokens' | 'cost', stack: 'account' | 'type'): WidgetChart {
  const accounts = d.accounts.map((a) => a.name);
  const byType = stack === 'type' && metric === 'tokens';
  const points = new Map(columns(d).map((ts) => [ts, {} as Record<string, number>]));
  for (const r of d.usage) {
    const v = points.get(r.ts);
    if (!v) continue;
    if (byType) for (const t of TOKEN_TYPES) v[t.key] = (v[t.key] ?? 0) + r[t.key];
    else if (accounts.includes(r.account)) v[r.account] = (v[r.account] ?? 0) + rowValue(r, metric);
  }
  return {
    title: `${metric === 'tokens' ? 'Tokens' : 'Estimated cost'} per ${PER[d.range]}`,
    series: byType ? TOKEN_TYPES.map((t) => ({ key: t.key, label: t.label })) : accounts.map((a) => ({ key: a, label: a })),
    ...(byType ? {} : { colorBy: 'account' as const }),
    points: [...points].map(([ts, values]) => ({ ts, values })),
    axis: d.range === '1h' || d.range === '24h' ? 'time' : 'date',
    format: metric === 'cost' ? 'usd' : 'compact',
  };
}

export function agentsChart(d: DashData): WidgetChart {
  const got = new Map((d.agents?.buckets ?? []).map((b) => [b.ts, b.total]));
  return {
    title: `Most agents at once per ${PER[d.range]}`,
    series: [{ key: 'total', label: 'Agents' }],
    points: columns(d).map((ts) => ({ ts, values: { total: got.get(ts) ?? 0 } })),
    axis: d.range === '1h' || d.range === '24h' ? 'time' : 'date',
    format: 'integer',
    height: 140,
  };
}

const NO_DATA: WidgetContent = { summary: 'No data yet: the collector has not run.' };

export const stats = definePlugin({
  name: 'stats',
  version: '1.0.0',
  description: 'Usage statistics on the dashboard: per account, tokens or cost over time, agents at work',
  filters: [
    { id: 'range', label: 'Time range', kind: 'segmented', default: '24h', options: async () => RANGES },
    { id: 'account', label: 'Account', kind: 'select', allLabel: 'All accounts', options: async (ctx: PluginContext) => (ctx.config.accounts ?? []).map((a) => ({ value: a.name, label: a.name })) },
    { id: 'env', label: 'Environment', kind: 'select', allLabel: 'All environments', options: async (ctx: PluginContext) => ctx.environments.map((e) => ({ value: e.name, label: e.name })) },
    { id: 'model', label: 'Model', kind: 'select', allLabel: 'All models', options: async (ctx: PluginContext) => ((await ctx.stats({ range: '30d' }))?.models ?? []).map((m) => ({ value: m, label: m })) },
    { id: 'metric', label: 'Metric', kind: 'segmented', default: 'tokens', options: async () => [{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }] },
    { id: 'stack', label: 'Stack by', kind: 'segmented', default: 'account', options: async () => [{ value: 'account', label: 'Account' }, { value: 'type', label: 'Token type' }] },
  ],
  widgets: [
    {
      id: 'accounts',
      title: 'Accounts',
      refreshSeconds: REFRESH,
      async run(ctx, p) {
        const d = await ctx.stats(query(p));
        if (!d) return NO_DATA;
        return d.accounts.map((a): WidgetCard => {
          const limit = a.dailyCostAlertUsd;
          return {
            key: a.name,
            title: a.name,
            account: a.name,
            ...(a.loggedIn === false ? { status: 'fail' as const, summary: 'login invalid' } : a.loggedIn ? { status: 'ok' as const, summary: 'logged in' } : { summary: 'login unknown' }),
            tiles: [
              { label: 'Today', value: compact(a.today.tokens), sub: `tokens · ~${usd(a.today.costUsd)}` },
              { label: 'This week', value: compact(a.week.tokens), sub: `tokens · ~${usd(a.week.costUsd)}` },
            ],
            ...(limit != null ? { meter: { label: `Daily cost alert at ${usd(limit)} (estimate)`, value: a.today.costUsd, max: limit } } : {}),
          };
        });
      },
    },
    {
      id: 'usage',
      title: 'Usage over time',
      size: 'wide',
      refreshSeconds: REFRESH,
      async run(ctx, p) {
        const d = await ctx.stats(query(p));
        if (!d) return NO_DATA;
        const metric = p['metric'] === 'cost' ? 'cost' : 'tokens';
        return {
          chart: usageChart(d, metric, p['stack'] === 'type' ? 'type' : 'account'),
          note: 'Cost is an estimate from Claude Code; on a subscription it is API-equivalent value, not billed money. Plan limits are not available.',
        };
      },
    },
    {
      id: 'agents',
      title: 'Agents at work',
      size: 'wide',
      refreshSeconds: REFRESH,
      async run(ctx, p) {
        const d = await ctx.stats(query(p));
        if (!d) return NO_DATA;
        if (!d.agents) return { summary: 'No agent samples yet.' };
        const n = d.agents.now;
        const plural = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
        return {
          summary: `now ${plural(n.sessions, 'session', 'sessions')} + ${plural(n.subagents, 'subagent', 'subagents')} · most at once in this range: ${d.agents.peak.total}`,
          chart: agentsChart(d),
          note: `Sessions running a turn plus the subagents they started, sampled every few seconds${p['account'] ? ` (${p['account']})` : ', all accounts'}.`,
        };
      },
    },
    {
      id: 'time',
      title: 'Where the time goes',
      size: 'wide',
      refreshSeconds: REFRESH,
      async run(ctx, p) {
        const d = await ctx.stats(query(p));
        if (!d) return NO_DATA;
        const t = d.profile;
        if (!t || t.busyMs === 0) return { summary: 'No tool runs recorded yet: the time profile starts with the first tool an agent runs after this update.' };
        const share = (ms: number): string => `${Math.round((ms / t.busyMs) * 100)}%`;
        const faster = (k: number): string => {
          if (t.cpuBoundMs == null) return '–';
          const saved = Math.round(((t.cpuBoundMs * (1 - 1 / k)) / t.busyMs) * 100);
          return saved > 0 ? `−${saved}%` : '0%';
        };
        return {
          summary: `${share(t.localOnlyMs)} of agent time was spent waiting on this host${t.cpuBoundMs == null ? '' : `, ${share(t.cpuBoundMs)} of it CPU-bound`}`,
          tiles: [
            { label: 'Agents working', value: hours(t.busyMs), sub: t.since > d.generatedAt - RANGE_MS[d.range] ? `recorded since ${new Date(t.since).toLocaleString()}` : `in the last ${d.range}` },
            { label: 'Model (API)', value: share(t.modelMs), sub: hours(t.modelMs) },
            { label: 'On this host only', value: share(t.localOnlyMs), sub: `${hours(t.localOnlyMs)} · local tools ${hours(t.localMs)} in all` },
            { label: 'CPU-bound', value: t.cpuBoundMs == null ? '–' : share(t.cpuBoundMs), sub: t.cpuBoundMs == null ? 'no CPU samples then' : hours(t.cpuBoundMs) },
            { label: 'Network tools', value: share(t.networkMs), sub: hours(t.networkMs) },
            { label: '2× faster CPU', value: faster(2), sub: `4× faster: ${faster(4)}` },
          ],
          rows: t.tools.map((x) => ({ label: x.tool, value: hours(x.ms), note: `${x.runs} run${x.runs === 1 ? '' : 's'} · avg ${seconds(x.ms / Math.max(1, x.runs))} · ${x.class === 'local' ? 'this host' : x.class === 'network' ? 'network' : x.class === 'nested' ? 'subagent (its own time is counted)' : 'waits for you'}` })),
          note: 'Per session, API requests and tool runs are merged so parallel subagents count once. "On this host only" is local tool time with nothing else running in that session: what a faster host can shorten. Its CPU-bound part comes from the session\'s CPU samples (at least half a core); the rest waits on disk, network calls inside Bash (npm, git), or sleeps. The faster-CPU figures assume only the CPU-bound part speeds up.',
        };
      },
    },
    {
      id: 'memory',
      title: 'Memory',
      refreshSeconds: REFRESH,
      async run(ctx, p) {
        const d = await ctx.stats(query(p));
        if (!d) return NO_DATA;
        const m = d.profile?.memory;
        if (!m) return { summary: 'No memory samples since the time profile started.' };
        const pressure = m.pressureShare == null ? null : Math.round(m.pressureShare * 100);
        return {
          status: pressure != null && pressure >= 10 ? 'warn' : (m.swapPeakBytes ?? 0) > 1024 ** 3 ? 'warn' : 'ok',
          summary: pressure == null ? 'No pressure readings yet.' : pressure > 0 ? `Under memory pressure ${pressure}% of the time` : 'No memory pressure in this range',
          tiles: [
            { label: 'Largest session', value: gib(m.sessionPeakBytes), sub: 'its process tree at peak' },
            { label: 'System peak', value: m.systemPeakPercent == null ? '–' : `${Math.round(m.systemPeakPercent)}%`, sub: d.host.memTotalBytes ? `of ${gib(d.host.memTotalBytes)}` : '' },
            { label: 'Swap peak', value: gib(m.swapPeakBytes) },
            { label: 'Pressure', value: pressure == null ? '–' : `${pressure}%`, sub: 'of samples at warning or critical' },
          ],
          note: 'Swap in use and memory pressure mean the host is short of RAM: more memory would speed agents up even where the CPU is idle.',
        };
      },
    },
  ],
});

const hours = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const seconds = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const gib = (b: number | null | undefined): string => (b == null ? '–' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
