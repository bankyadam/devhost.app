import type { DashData } from '@devhost/contract/lite';
import type { Bucket } from '../ui/chart';

export type Range = DashData['range'];
export type Metric = 'tokens' | 'cost';
export type Stack = 'account' | 'type';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const BUCKET_MS: Record<Range, number> = { '1h': 5 * MIN, '24h': HOUR, '7d': 6 * HOUR, '30d': DAY };
export const RANGE_MS: Record<Range, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

export const TOKEN_TYPES = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheCreation', label: 'Cache write' },
] as const;

type Row = DashData['usage'][number];

/** The value of one usage row for a metric, optionally narrowed to one token type. */
export function rowValue(r: Row, metric: Metric, type?: (typeof TOKEN_TYPES)[number]['key']): number {
  if (metric === 'cost') return r.costUsd;
  return type ? r[type] : r.input + r.output + r.cacheRead + r.cacheCreation;
}

/**
 * Dense buckets over the whole range (empty ones are zero, so gaps are visible), each with one
 * value per series key. `accounts` limits which accounts count when stacking by account.
 */
export function buildBuckets(d: DashData, metric: Metric, stack: Stack, accounts: readonly string[]): Bucket[] {
  const size = BUCKET_MS[d.range];
  const end = Math.floor(d.generatedAt / size) * size;
  const start = Math.floor((d.generatedAt - RANGE_MS[d.range]) / size) * size + size;
  const buckets = new Map<number, Record<string, number>>();
  for (let t = start; t <= end; t += size) buckets.set(t, {});
  for (const r of d.usage) {
    const b = buckets.get(r.ts);
    if (!b) continue;
    if (stack === 'account') {
      if (accounts.includes(r.account)) b[r.account] = (b[r.account] ?? 0) + rowValue(r, metric);
    } else {
      for (const t of TOKEN_TYPES) b[t.key] = (b[t.key] ?? 0) + r[t.key];
    }
  }
  return [...buckets.entries()].map(([ts, values]) => ({ ts, values }));
}

export function bucketLabel(range: Range): (ts: number) => string {
  return (ts) => {
    const d = new Date(ts);
    return range === '1h' || range === '24h'
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
}

/** Quota meter tone: fills accent → warning at 80 % → danger at 100 %. */
export function meterTone(fraction: number): '' | 'warn' | 'bad' {
  return fraction >= 1 ? 'bad' : fraction >= 0.8 ? 'warn' : '';
}
