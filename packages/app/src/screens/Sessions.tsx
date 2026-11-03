import { useEffect, useState } from 'react';
import type { EnvListData } from '@devhost/contract/lite';
import { devServerUrl } from '../lib/host';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { ago, bytes, compact, pct, usd } from '../lib/format';
import { LARGE_CONTEXT_TOKENS, sortSessions, STATE_LABEL, type Session, type SortDir, type SortKey } from '../lib/sessions';
import { Badge, CopyButton, Empty, Menu } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';
import type { SessionHandoffData } from '@devhost/contract/lite';
import { useDash } from '../use-dash';
import { PluginRunDialog } from '../ui/plugin-run';
import { usePlugins, type PluginActionInfo } from '../use-plugins';
import { openClaude, useWebApps } from '../use-web-apps';
import { QrCell, QrDialog } from '../ui/qr';

/** The sessions that are open now, all accounts together: ended ones are not listed. */
export function Sessions({ qr, onQr }: { qr: boolean; onQr: (on: boolean) => void }) {
  const { client, transport, connection, hostName: hostLabel } = useApp();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'lastActivityAt', dir: 'desc' });
  const [envs, setEnvs] = useState<EnvListData['environments']>([]);
  const { dash, loading, error, stale } = useDash('24h', {});
  const webApps = useWebApps();
  const plugins = usePlugins();
  const [pluginRun, setPluginRun] = useState<{ action: PluginActionInfo; session: string } | null>(null);
  const [handoff, setHandoff] = useState<{ session: Session; fresh: boolean } | null>(null);
  const [qrOf, setQrOf] = useState<Session | null>(null);
  const [termError, setTermError] = useState<string | null>(null);
  const openTerminal = (r: Parameters<typeof transport.openTerminal>[0]) => {
    setTermError(null);
    transport.openTerminal(r).catch((e: unknown) => setTermError(`Could not open Terminal: ${errorMessage(e)}`));
  };

  const [dnsName, setDnsName] = useState<string | null>(null);
  useEffect(() => {
    if (connection.kind === 'connected') void client.status().then((st) => setDnsName(st.host.tailscale?.dnsName ?? null)).catch(() => undefined);
  }, [client, connection.kind]);
  useEffect(() => {
    if (connection.kind === 'connected') void client.envs().then((e) => setEnvs(e.environments)).catch(() => undefined);
  }, [client, connection.kind, dash?.environments.length]);

  if (!dash) {
    return <div className="content"><h1>Sessions</h1><Empty>{error ? `Could not load the sessions: ${error}` : loading ? 'Loading the sessions…' : 'No data yet.'}</Empty></div>;
  }

  const now = dash.generatedAt;
  const sessions = sortSessions(dash.sessions.filter((s) => s.state !== 'ended'), sort.key, sort.dir);
  const waiting = sessions.filter((s) => s.state === 'waiting').length;

  return (
    <div className="content" style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="row">
        <h1>Sessions</h1>
        {waiting > 0 && <Badge tone="warn">{waiting} waiting for input</Badge>}
        {stale && <Badge tone="warn">showing the last data</Badge>}
        {error && <span className="note" role="alert">{error}</span>}
        {termError && <span className="note" role="alert">{termError}</span>}
        <label className="check" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={qr} onChange={(e) => onQr(e.target.checked)} /> QR codes</label>
      </div>
      <section className="card" aria-label="Sessions">
        <header><h2>Idle and active</h2><span className="note">Claude Code sessions on {hostLabel}, all accounts together.</span></header>
        {sessions.length === 0 ? <Empty>No idle or active sessions.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {([['account', 'Account'], ['env', 'Environment'], ['id', 'Session'], ['state', 'State'], ['startedAt', 'Started'], ['lastActivityAt', 'Last activity'], ['contextTokens', 'Context'], ['tokensToday', 'Tokens today'], ['costToday', 'Cost today'], ['cpuPercent', 'CPU'], ['rssBytes', 'RAM']] as [SortKey, string][]).map(([key, text]) => (
                    <th key={key} className={['contextTokens', 'tokensToday', 'costToday', 'cpuPercent', 'rssBytes'].includes(key) ? 'num' : ''} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>{text}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                    </th>
                  ))}
                  {qr && <th>Phone</th>}
                  <th><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => <SessionRow key={s.id} s={s} now={now} dir={envs.find((e) => e.name === s.env)?.dir} portBase={dash.environments.find((e) => e.name === s.env)?.portBase ?? null} dnsName={dnsName} app={s.account ? webApps.appFor(s.account) : null} envUrl={envs.find((e) => e.name === s.env)?.remoteControl.url} actions={plugins.actions('session')} onAction={(action) => setPluginRun({ action, session: s.id })} onHandoff={(fresh) => setHandoff({ session: s, fresh })} qr={qr} onQr={() => setQrOf(s)} onTerminal={openTerminal} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          Context is what each next request reads again: over {compact(LARGE_CONTEXT_TOKENS)} a session gets expensive, so /compact it or continue in a new session from its handoff note.
          A large session left idle gets a handoff note before its prompt cache expires (an hour). CPU and RAM per session are best effort (matched by working directory); the numbers on the Environments screen are reliable.
        </p>
      </section>
      {qrOf?.remoteSession && <QrDialog title={`Open on the phone · ${qrOf.env ?? ''} ${qrOf.id.slice(0, 8)}`} url={sessionUrl(qrOf.remoteSession)} note="Scan with the phone's camera: the session opens on claude.ai/code, or in the Claude app when it is installed. You need to be signed in to its account there." onClose={() => setQrOf(null)} />}
      {handoff && <HandoffDialog session={handoff.session} fresh={handoff.fresh} onClose={() => setHandoff(null)} />}
      {pluginRun && <PluginRunDialog action={pluginRun.action} target={{ session: pluginRun.session }} onClose={() => setPluginRun(null)} />}
    </div>
  );
}

const sessionUrl = (remoteSession: string): string => `https://claude.ai/code/${remoteSession}`;

function SessionRow({ s, now, dir, portBase, dnsName, app, envUrl, actions, onAction, onHandoff, qr, onQr, onTerminal }: { onTerminal: (r: { kind: 'resume'; dir: string; sessionId: string } | { kind: 'shell'; dir: string }) => void; s: Session; now: number; dir?: string; portBase: number | null; dnsName: string | null; app: string | null; envUrl?: string; actions: PluginActionInfo[]; onAction: (a: PluginActionInfo) => void; onHandoff: (fresh: boolean) => void; qr: boolean; onQr: () => void }) {
  const { transport, tools } = useApp();
  return (
    <tr className={s.state === 'waiting' ? 'waiting' : ''}>
      <td>{s.account ?? '–'}</td>
      <td>{s.env ?? '–'}</td>
      <td className="session" title={s.title ? `${s.titleFromPrompt ? 'Last prompt: ' : ''}${s.title}\n${s.id}` : s.id}>
        {s.title && <div className={s.titleFromPrompt ? 'last-prompt' : undefined}>{s.title}</div>}
        <div className={s.title ? 'note mono' : 'mono'}>{s.id.slice(0, 8)}</div>
        {s.subagents && s.subagents.total > 0 && (
          <div className="note" title={s.subagents.types.join(', ')}>
            {s.subagents.running > 0 ? <Badge tone="good">{`+${s.subagents.running} ${s.subagents.running === 1 ? 'subagent' : 'subagents'} running`}</Badge> : null} {s.subagents.total} {s.subagents.total === 1 ? 'subagent' : 'subagents'}{s.subagents.types.length > 0 ? ` (${s.subagents.types.join(', ')})` : ''}
          </div>
        )}
      </td>
      <td>{s.state === 'waiting' ? <Badge tone="warn">{STATE_LABEL[s.state]}</Badge> : s.state === 'running' ? <Badge tone="good">running</Badge> : <Badge>{STATE_LABEL[s.state]}</Badge>}</td>
      <td>{ago(s.startedAt, now)}</td>
      <td>{ago(s.lastActivityAt, now)}</td>
      <td className="num">
        {s.contextTokens == null ? '–' : s.contextTokens >= LARGE_CONTEXT_TOKENS ? <Badge tone="warn">{compact(s.contextTokens)}</Badge> : compact(s.contextTokens)}
        {s.handoffAt != null && <div className="note" title={`Handoff note written ${new Date(s.handoffAt).toLocaleString()}`}>note {ago(s.handoffAt, now)}</div>}
      </td>
      <td className="num">{compact(s.tokensToday)}</td>
      <td className="num">{usd(s.costToday)}</td>
      <td className="num">{pct(s.cpuPercent)}</td>
      <td className="num">{bytes(s.rssBytes)}</td>
      {qr && <td>{s.remoteSession ? <QrCell url={sessionUrl(s.remoteSession)} label={`QR code of session ${s.id.slice(0, 8)}`} onOpen={onQr} /> : <span className="note" title="Not a Remote Control session: it cannot be opened on the phone">–</span>}</td>}
      <td>
        <Menu
          label="Open"
          items={[
            { label: app ? `claude.ai/code (${app})` : 'claude.ai/code', onSelect: () => void openClaude(transport, app, s.remoteSession ? sessionUrl(s.remoteSession) : envUrl) },
            { label: 'QR code for the phone', hidden: !s.remoteSession, onSelect: onQr },
            { label: s.handoffAt != null && s.handoffAt >= s.lastActivityAt ? 'Handoff note' : 'Write a handoff note', hidden: s.state === 'running', onSelect: () => onHandoff(false) },
            { label: 'Write the handoff note again', hidden: s.state === 'running' || s.handoffAt == null || s.handoffAt < s.lastActivityAt, onSelect: () => onHandoff(true) },
            { label: 'Terminal: resume this session', hidden: !dir, onSelect: () => onTerminal({ kind: 'resume', dir: dir!, sessionId: s.id }) },
            { label: 'Terminal: shell in the environment', hidden: !dir, onSelect: () => onTerminal({ kind: 'shell', dir: dir! }) },
            { label: 'VS Code (Remote SSH)', hidden: !dir || !tools.code, onSelect: () => void transport.openVscode(dir!) },
            { label: portBase ? `Dev server (port ${portBase})` : 'Dev server', hidden: portBase == null, onSelect: () => void transport.openUrl(devServerUrl(transport.host, dnsName, portBase!)) },
            ...actions.map((a) => ({ label: `${a.title}${a.destructive ? '…' : ''}`, danger: a.destructive, onSelect: () => onAction(a) })),
          ]}
        />
      </td>
    </tr>
  );
}

/** A session's handoff note: shown, or written by a one-off fork of the session (about one request's cost). */
function HandoffDialog({ session, fresh, onClose }: { session: Session; fresh: boolean; onClose: () => void }) {
  const { client } = useApp();
  return (
    <RunDialog<SessionHandoffData>
      title={`Handoff note · ${session.env ?? ''} ${session.id.slice(0, 8)}`}
      begin={(h) => client.sessionHandoff(session.id, fresh, h)}
      terminal={{ kind: 'devhost', args: ['session', 'handoff', session.id, ...(fresh ? ['--new'] : [])] }}
      onClose={onClose}
      after={(r) => (r.data ? (
        <>
          <div className="row"><CopyButton text={r.data.text} label="Copy the note" /><span className="note">{r.data.written ? 'Written now' : `Written ${new Date(r.data.at).toLocaleString()}`} · {r.data.path}</span></div>
          <pre className="logview" aria-label="Handoff note">{r.data.text}</pre>
        </>
      ) : null)}
    >
      <p className="sec">Paste it as the first message of a new session to continue where this one stopped.</p>
    </RunDialog>
  );
}
