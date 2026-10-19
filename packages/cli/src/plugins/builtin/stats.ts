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
  ],
});
