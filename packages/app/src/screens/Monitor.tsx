import { useEffect } from 'react';
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

/**
 * A screen to leave open on a second monitor (spec B3.1.2): every open session as a card with a lamp
 * for its state, a prompt icon when it waits for input, the numbers that matter for the work at
 * hand, and the QR code of its Remote Control link for the phone. Full screen hides the app's
 * sidebar and top bar (Esc leaves it).
 */
export function Monitor({ full, onFull }: { full: boolean; onFull: (on: boolean) => void }) {
  const { hostName } = useApp();
  const { dash, loading, error, stale } = useDash('24h', {});

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, onFull]);

  const fullButton = <button className="btn sm" onClick={() => onFull(!full)}>{full ? 'Leave full screen' : 'Full screen'}</button>;
  if (!dash) {
    return <div className="content monitor"><div className="row"><h1>Monitor</h1><span style={{ marginLeft: 'auto' }}>{fullButton}</span></div><Empty>{error ? `Could not load the sessions: ${error}` : loading ? 'Loading the sessions…' : 'No data yet.'}</Empty></div>;
  }

  const now = dash.generatedAt;
  const sessions = monitorOrder(dash.sessions);
  const count = (state: Session['state']): number => sessions.filter((s) => s.state === state).length;
  const waiting = count('waiting');
  const costToday = dash.accounts.reduce((a, x) => a + x.today.costUsd, 0);
  const costLastHour = dash.environments.reduce((a, e) => a + e.costLastHour, 0);
  const agentsNow = dash.agents ? dash.agents.now.sessions + dash.agents.now.subagents : null;

  return (
    <div className={`content monitor${full ? ' full' : ''}`}>
      <div className="row">
        <h1>{hostName}</h1>
        <span className="note">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {stale && <Badge tone="warn">showing the last data</Badge>}
        {error && <span className="note" role="alert">{error}</span>}
        <span style={{ marginLeft: 'auto' }}>{fullButton}</span>
      </div>
      <div className="mon-stats" aria-label="At a glance">
        <Stat label="Waiting for input" value={String(waiting)} tone={waiting > 0 ? 'warn' : undefined} />
        <Stat label="Running" value={String(count('running'))} sub={`${count('idle')} idle`} />
        <Stat label="Agents at work" value={agentsNow === null ? '–' : String(agentsNow)} sub={dash.agents ? `${dash.agents.now.subagents} subagents · peak ${dash.agents.peak.total}` : undefined} />
        <Stat label="Cost today" value={usd(costToday)} sub="estimate" />
        <Stat label="Last hour" value={usd(costLastHour)} sub="estimate" />
        <Stat label="CPU · memory" value={`${pct(dash.host.cpuPercent)} · ${pct(dash.host.memPercent)}`} tone={(dash.host.memPercent ?? 0) >= 90 ? 'warn' : undefined} />
        <Stat label="Alerts" value={String(dash.alerts.length)} sub={dash.alerts[0]?.message} tone={dash.alerts.length > 0 ? 'bad' : undefined} />
      </div>
      {sessions.length === 0 ? <Empty>No idle or active sessions.</Empty> : (
        <div className="mon-grid">
          {sessions.map((s) => <SessionCard key={s.id} s={s} now={now} />)}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`mon-stat${tone ? ` ${tone}` : ''}`}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub" title={sub}>{sub}</span>}
    </div>
  );
}

/** A speech bubble with a prompt in it: the session asks something and waits for an answer. */
function PromptIcon() {
  return (
    <svg className="mon-prompt" role="img" aria-label="Waiting for your input" viewBox="0 0 24 24" width="26" height="26">
      <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" />
      <path d="M7 8l3 2.5L7 13M12 13h5" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SessionCard({ s, now }: { s: Session; now: number }) {
  const url = s.remoteSession ? `https://claude.ai/code/${s.remoteSession}` : null;
  const ctx = s.contextTokens ?? null;
  const since = `last activity ${ago(s.lastActivityAt, now)}`;
  return (
    <article className={`mon-card ${s.state}`} aria-label={`Session ${s.title ?? s.id.slice(0, 8)}`}>
      <header>
        <span className={`lamp ${s.state}`} role="img" aria-label={STATE_LABEL[s.state]} />
        <span className="mon-state"><b>{STATE_LABEL[s.state]}</b> <span className="note">{since}</span></span>
        {s.state === 'waiting' && <PromptIcon />}
      </header>
      <div className="mon-main">
        <div className="mon-text">
          <div className={`mon-title${s.titleFromPrompt ? ' last-prompt' : ''}`} title={s.title ?? s.id}>{s.title ?? s.id.slice(0, 8)}</div>
          <div className="note">{s.account ?? '–'} / {s.env ?? '–'} · <span className="mono">{s.id.slice(0, 8)}</span></div>
          <dl className="mon-facts">
            <dt>Context</dt>
            <dd>
              {ctx === null ? '–' : ctx >= LARGE_CONTEXT_TOKENS ? <Badge tone="warn">{compact(ctx)}</Badge> : compact(ctx)}
              {ctx !== null && <span className="mon-bar" aria-hidden="true"><i className={ctx >= LARGE_CONTEXT_TOKENS ? 'warn' : ''} style={{ width: `${Math.min(100, (ctx / (LARGE_CONTEXT_TOKENS * 1.5)) * 100)}%` }} /></span>}
            </dd>
            <dt>Cost today</dt><dd>{usd(s.costToday)}</dd>
            <dt>Subagents</dt><dd>{s.subagents && s.subagents.running > 0 ? <Badge tone="good">{`${s.subagents.running} running`}</Badge> : (s.subagents?.total ?? 0) > 0 ? `${s.subagents!.total} done` : '–'}</dd>
            <dt>Started</dt><dd>{ago(s.startedAt, now)}</dd>
            {s.handoffAt != null && <><dt>Handoff</dt><dd>note {ago(s.handoffAt, now)}</dd></>}
          </dl>
        </div>
        {url ? <QrCode text={url} px={128} label={`QR code of session ${s.id.slice(0, 8)}`} /> : <div className="mon-noqr note" title="Not a Remote Control session: it cannot be opened on the phone">local session</div>}
      </div>
    </article>
  );
}
