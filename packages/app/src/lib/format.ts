export const pct = (v: number | null | undefined): string => (v == null ? '–' : `${Math.round(v)}%`);

export function bytes(v: number | null | undefined): string {
  if (v == null) return '–';
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(1)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  return `${Math.round(v / 1024)} KB`;
}

/** 1,284 / 12.9K / 4.2M */
export function compact(v: number): string {
  if (v >= 1e9) return `${trim(v / 1e9)}B`;
  if (v >= 1e6) return `${trim(v / 1e6)}M`;
  if (v >= 1e4) return `${trim(v / 1e3)}K`;
  return Math.round(v).toLocaleString('en-US');
}
const trim = (n: number): string => (n >= 100 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');

export const usd = (v: number): string => `$${v.toFixed(v >= 100 ? 0 : 2)}`;

export function ago(ms: number | null | undefined, now: number): string {
  if (ms == null) return '–';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return '–';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
