import { useEffect, useMemo, useRef, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  /** CSS color (a `var(--series-n)`). */
  color: string;
}

export interface Bucket {
  ts: number;
  values: Record<string, number>;
}

interface Props {
  buckets: Bucket[];
  series: Series[];
  format: (v: number) => string;
  /** Formats the bucket start for axis and tooltip. */
  label: (ts: number) => string;
  title: string;
  height?: number;
}

const GAP = 2; // the surface gap between stacked segments
const MAX_BAR = 24;
const RADIUS = 4;

/** "Nice" axis maximum and tick step for a value. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 1 / ticks };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/**
 * Stacked columns over time. Marks follow the data-viz specs: thin (<= 24px) columns, 4px rounded
 * data-end square at the baseline, a 2px surface gap between segments, hairline grid, text in ink
 * (never the series color), a legend for two or more series, and a per-column tooltip that is
 * also reachable by keyboard focus.
 */
export function StackedColumns({ buckets, series, format, label, title, height = 220 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw in real pixels so the 24px bar cap and 2px gaps are what the reader sees.
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(Math.max(320, Math.round(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(320, Math.round(el.clientWidth)) || 720);
    return () => ro.disconnect();
  }, []);
  const pad = { l: 44, r: 8, t: 8, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const totals = buckets.map((b) => series.reduce((a, s) => a + (b.values[s.key] ?? 0), 0));
  const scale = useMemo(() => niceScale(Math.max(0, ...totals)), [totals.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const slot = buckets.length > 0 ? innerW / buckets.length : innerW;
  const barW = Math.min(MAX_BAR, Math.max(2, slot - 4));
  const y = (v: number): number => pad.t + innerH - (v / scale.max) * innerH;
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 7));

  const tip = hover === null ? null : buckets[hover];
  const tipX = hover === null ? 0 : ((pad.l + slot * hover + slot / 2) / W) * 100;

  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={title}>
        <g className="grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
        </g>
        {buckets.map((b, i) => {
          const x = pad.l + slot * i + (slot - barW) / 2;
          let acc = 0;
          const segs = series
            .map((s) => ({ s, v: b.values[s.key] ?? 0 }))
            .filter((x2) => x2.v > 0)
            .map(({ s, v }) => {
              const y0 = y(acc);
              acc += v;
              return { s, v, top: y(acc), bottom: y0 };
            });
          return (
            <g key={b.ts}>
              {segs.map((seg, k) => {
                const isTop = k === segs.length - 1;
                const h = Math.max(1, seg.bottom - seg.top - (k > 0 ? GAP : 0));
                const yTop = seg.top;
                const r = isTop ? Math.min(RADIUS, h, barW / 2) : 0;
                // Rounded data-end (top) only; the stack stays square at the baseline and between segments.
                const d = `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`;
                return <path key={seg.s.key} className="seg" d={d} fill={seg.s.color} />;
              })}
              <rect
                className="hit"
                x={pad.l + slot * i}
                y={pad.t}
                width={slot}
                height={innerH}
                tabIndex={0}
                aria-label={`${label(b.ts)}: ${series.map((s) => `${s.label} ${format(b.values[s.key] ?? 0)}`).join(', ')}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
              {i % labelEvery === 0 && <text x={x + barW / 2} y={height - 6} textAnchor="middle">{label(b.ts)}</text>}
            </g>
          );
        })}
        <line className="baseline" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
      </svg>
      {tip && (
        <div className="tip" style={{ left: `${tipX}%`, top: 0 }} role="status">
          <div className="t">{label(tip.ts)}</div>
          {series.map((s) => (
            <div className="r" key={s.key}>
              <span><i className="k" style={{ background: s.color }} />{s.label}</span>
              <b>{format(tip.values[s.key] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null; // a single series is named by the chart title
  return (
    <div className="legend" aria-label="Legend">
      {series.map((s) => (
        <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
      ))}
    </div>
  );
}
