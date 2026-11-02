import { useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { ago, compact, pct, usd } from '../lib/format';
import { LARGE_CONTEXT_TOKENS, STATE_LABEL, type Session } from '../lib/sessions';
import { Badge, Empty } from '../ui/primitives';
import { QrCode } from '../ui/qr';
import { useDash } from '../use-dash';

const ORDER: Record<Session['state'], number> = { waiting: 0, running: 1, idle: 2, ended: 3 };

/** Waiting for input first (they need a human), then running, then idle; the latest activity first within each. */
export function monitorOrder(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.state !== 'ended').sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/** A card is at least this many times as wide as tall: the square QR code plus its text beside it. */
const CARD_ASPECT = 2.6;
const MAX_CARD_PX = 170;
const GAP_PX = 8;

/**
 * The columns and the card height that fit `n` cards into `width` × `height` without scrolling, each
 * card as large as it can be (up to a cap: a larger QR code reads no better); at the cap, more
 * columns rather than a few very wide cards.
 */
export function monitorGrid(n: number, width: number, height: number, gap = GAP_PX): { cols: number; cardPx: number } {
  let best = { cols: 1, cardPx: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.max(1, Math.ceil(n / cols));
    const w = (width - (cols - 1) * gap) / cols;
    const h = (height - (rows - 1) * gap) / rows;
    const size = Math.min(h, w / CARD_ASPECT, MAX_CARD_PX);
    if (size > best.cardPx || (size === MAX_CARD_PX && best.cardPx === MAX_CARD_PX)) best = { cols, cardPx: size };
  }
  return { cols: best.cols, cardPx: Math.floor(best.cardPx) };
}

/** The grid's own size, so the cards can be laid out to fit it (jsdom has no ResizeObserver: a fixed size there). */
function useSize<T extends HTMLElement>(): [React.RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/**
 * The monitor window the menu bar opens, to leave on a second monitor (spec B3.1.2): every open
 * session as a compact card with a lamp for its state, a prompt icon when it waits for input, and the
 * QR code of its Remote Control link, all of them always on screen; a strip of the numbers that
 * matter for the work at hand above them.
 */
export function Monitor() {
  const { hostName } = useApp();
  const { dash, loading, error, stale } = useDash('24h', {});
  const [gridRef, size] = useSize<HTMLDivElement>();

  const sessions = dash ? monitorOrder(dash.sessions) : [];
  const { cols, cardPx } = monitorGrid(sessions.length, size.width, size.height);

  let strip = null;
  if (dash) {
    const count = (state: Session['state']): number => sessions.filter((s) => s.state === state).length;
    const waiting = count('waiting');
    const agentsNow = dash.agents ? dash.agents.now.sessions + dash.agents.now.subagents : null;
    strip = (
      <div className="mon-stats" aria-label="At a glance">
        <Stat label="Waiting" value={String(waiting)} tone={waiting > 0 ? 'warn' : undefined} />
        <Stat label="Running" value={String(count('running'))} />
        <Stat label="Idle" value={String(count('idle'))} />
        <Stat label="Agents" value={agentsNow === null ? '–' : String(agentsNow)} title={dash.agents ? `${dash.agents.now.subagents} subagents now · peak ${dash.agents.peak.total}` : undefined} />
        <Stat label="Today" value={usd(dash.accounts.reduce((a, x) => a + x.today.costUsd, 0))} title="Estimated cost today" />
        <Stat label="Last hour" value={usd(dash.environments.reduce((a, e) => a + e.costLastHour, 0))} title="Estimated cost in the last 60 minutes" />
        <Stat label="CPU" value={pct(dash.host.cpuPercent)} />
        <Stat label="Memory" value={pct(dash.host.memPercent)} tone={(dash.host.memPercent ?? 0) >= 90 ? 'warn' : undefined} />
        {dash.alerts.length > 0 && <Stat label="Alerts" value={String(dash.alerts.length)} title={dash.alerts.map((a) => a.message).join('\n')} tone="bad" />}
      </div>
    );
  }

  return (
    <div className="monitor">
      <div className="mon-head">
        <h1>{hostName}</h1>
        {stale && <Badge tone="warn">showing the last data</Badge>}
        {strip}
      </div>
      <div className="mon-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${cardPx}px` }}>
        {!dash ? (
          <Empty>{error ? `Could not load the sessions: ${error}` : loading ? 'Loading the sessions…' : 'No data yet.'}</Empty>
        ) : sessions.length === 0 ? (
          <Empty>No idle or active sessions.</Empty>
        ) : (
          sessions.map((s) => <SessionCard key={s.id} s={s} now={dash.generatedAt} qrPx={Math.max(40, cardPx - 2 * GAP_PX)} />)
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`mon-stat${tone ? ` ${tone}` : ''}`} title={title}>
      <span className="label">{label}</span> <span className="value">{value}</span>
    </div>
  );
}

/** A speech bubble with a prompt in it: the session asks something and waits for an answer. */
function PromptIcon() {
  return (
    <svg className="mon-prompt" role="img" aria-label="Waiting for your input" viewBox="0 0 24 24" width="20" height="20">
      <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" />
      <path d="M7 8l3 2.5L7 13M12 13h5" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SessionCard({ s, now, qrPx }: { s: Session; now: number; qrPx: number }) {
  const url = s.remoteSession ? `https://claude.ai/code/${s.remoteSession}` : null;
  const ctx = s.contextTokens ?? null;
  const title = s.title ?? s.id.slice(0, 8);
  return (
    <article className={`mon-card ${s.state}`} aria-label={`Session ${title}`}>
      <div className="mon-text">
        <div className="mon-line">
          <span className={`lamp ${s.state}`} role="img" aria-label={STATE_LABEL[s.state]} title={STATE_LABEL[s.state]} />
          <span className={`mon-title${s.titleFromPrompt ? ' last-prompt' : ''}`} title={s.title ?? s.id}>{title}</span>
          {s.state === 'waiting' && <PromptIcon />}
        </div>
        <div className="mon-meta note">{s.env ?? s.account ?? '–'} · {ago(s.lastActivityAt, now)}</div>
        <div className="mon-meta">
          {ctx !== null && (ctx >= LARGE_CONTEXT_TOKENS ? <Badge tone="warn">{compact(ctx)}</Badge> : <span title="Context">{compact(ctx)}</span>)}
          <span>{usd(s.costToday)}</span>
          {s.subagents && s.subagents.running > 0 && <Badge tone="good">{`+${s.subagents.running} agents`}</Badge>}
        </div>
      </div>
      {url ? <QrCode text={url} px={qrPx} label={`QR code of session ${s.id.slice(0, 8)}`} /> : <div className="mon-noqr note" style={{ width: qrPx, height: qrPx }} title="Not a Remote Control session: it cannot be opened on the phone">local</div>}
    </article>
  );
}
