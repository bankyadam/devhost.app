import { useEffect, useState } from 'react';
import type { DashData, EnvListData, SessionReattachData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { seriesSlot, seriesVar } from '../lib/colors';
import { ago, bytes, compact, duration, pct, usd } from '../lib/format';
import { filterSessions, sortSessions, STATE_LABEL, type Session, type SortDir, type SortKey } from '../lib/sessions';
import { meterTone } from '../lib/usage';
import { Legend, StackedColumns, type Series } from '../ui/chart';
import { RunDialog } from '../ui/run-dialog';
import { Badge, Empty, Menu, Segmented } from '../ui/primitives';
import { useDash } from '../use-dash';
import { PluginRunDialog } from '../ui/plugin-run';
import { usePlugins, usePluginWidgets, type PluginActionInfo, type PluginFilter, type PluginWidget } from '../use-plugins';
import { openClaude, useWebApps } from '../use-web-apps';


export function Dashboard({ params = {}, onParams = () => undefined }: { params?: Record<string, string>; onParams?: (p: Record<string, string>) => void }) {
  const { client, transport, connection } = useApp();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'lastActivityAt', dir: 'desc' });
  const [known, setKnown] = useState<string[]>([]);
  const [envs, setEnvs] = useState<EnvListData['environments']>([]);

  // Health, environments and sessions: the statistics (and their filters) are the stats plugin's.
  const { dash, loading, error, stale } = useDash('24h', {});
  const webApps = useWebApps();
  const plugins = usePlugins();
  const widgets = usePluginWidgets(params);
  const [pluginRun, setPluginRun] = useState<{ action: PluginActionInfo; session?: string } | null>(null);
  const [reattach, setReattach] = useState<string | null>(null);

  // Account colors follow the account, not its rank: remember every account ever seen, in order.
  useEffect(() => {
    if (dash) setKnown((k) => [...k, ...dash.accounts.map((a) => a.name).filter((n) => !k.includes(n))]);
  }, [dash]);
  useEffect(() => {
    if (connection.kind === 'connected') void client.envs().then((e) => setEnvs(e.environments)).catch(() => undefined);
  }, [client, connection.kind, dash?.environments.length]);

  const now = dash?.generatedAt ?? Date.now();
  const hostName = transport.host.replace(/^.*@/, '');

  if (!dash) {
    return <div className="content"><h1>Dashboard</h1><Empty>{error ? `Could not load the dashboard: ${error}` : loading ? 'Loading the dashboard…' : 'No data yet.'}</Empty></div>;
  }

  const accountNames = known.length > 0 ? known : dash.accounts.map((a) => a.name);
  const sessions = sortSessions(filterSessions(dash.sessions, {}), sort.key, sort.dir);
  const waiting = dash.sessions.filter((s) => s.state === 'waiting').length;


  const envDir = (name: string | null): string | undefined => envs.find((e) => e.name === name)?.dir;

  return (
    <div className="content" style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="row">
        <h1>Dashboard</h1>
        {waiting > 0 && <Badge tone="warn">{waiting} waiting for input</Badge>}
        {stale && <Badge tone="warn">showing the last data</Badge>}
        {error && <span className="note" role="alert">{error}</span>}
      </div>

      <Health dash={dash} now={now} />

      <PluginWidgets
        filters={widgets.filters}
        widgets={widgets.widgets}
        params={params}
        accountNames={accountNames}
        onParam={(key, value) => onParams({ ...params, [key]: value })}
        actionFor={(w) => (w.action ? plugins.action(w.plugin, w.action) : undefined)}
        onAction={(action) => setPluginRun({ action })}
      />

      {dash.alerts.length > 0 && (
        <div className="notice bad" role="alert">
          {dash.alerts.map((a) => (
            <div key={a.id}><b>{a.id.split(':')[0]}</b>: {a.message}</div>
          ))}
        </div>
      )}

      <section className="card" aria-label="Environments">
        <header><h2>Environments</h2></header>
        {dash.environments.length === 0 ? <Empty>No environments yet.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Environment</th><th>Remote Control</th><th className="num">CPU</th><th className="num">RAM</th><th className="num">Containers</th><th>Ports</th><th className="num">Disk</th><th className="num">Sessions</th></tr></thead>
              <tbody>
                {dash.environments.map((e) => (
                  <tr key={`${e.account}/${e.name}`}>
                    <td><b>{e.name}</b> <span className="muted">{e.account}</span></td>
                    <td>{e.service.state === 'running' ? <Badge tone="good">running</Badge> : e.service.state === 'stopped' ? <Badge tone="bad">stopped</Badge> : <Badge>{e.service.state}</Badge>}</td>
                    <td className="num">{pct(e.cpuPercent)}</td>
                    <td className="num">{bytes(e.rssBytes)}</td>
                    <td className="num">{e.containerCpuPercent == null ? '–' : `${pct(e.containerCpuPercent)} · ${bytes(e.containerMemBytes)}`}</td>
                    <td className="mono">{e.portBase == null ? '–' : `${e.portBase}–${e.portBase + 99}`}</td>
                    <td className="num">{bytes(e.diskBytes)}</td>
                    <td className="num">{e.activeSessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Sessions">
        <header><h2>Sessions</h2><span className="note">Claude Code sessions on this Mac mini, all accounts together.</span></header>
        {sessions.length === 0 ? <Empty>No sessions in this view.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {([['account', 'Account'], ['env', 'Environment'], ['id', 'Session'], ['state', 'State'], ['startedAt', 'Started'], ['lastActivityAt', 'Last activity'], ['tokensToday', 'Tokens today'], ['costToday', 'Cost today'], ['cpuPercent', 'CPU'], ['rssBytes', 'RAM']] as [SortKey, string][]).map(([key, text]) => (
                    <th key={key} className={['tokensToday', 'costToday', 'cpuPercent', 'rssBytes'].includes(key) ? 'num' : ''} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>{text}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                    </th>
                  ))}
                  <th><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => <SessionRow key={s.id} s={s} now={now} dir={envDir(s.env)} portBase={dash.environments.find((e) => e.name === s.env)?.portBase ?? null} hostName={hostName} app={s.account ? webApps.appFor(s.account) : null} envUrl={envs.find((e) => e.name === s.env)?.remoteControl.url} actions={plugins.actions('session')} onAction={(action) => setPluginRun({ action, session: s.id })} onReattach={() => setReattach(s.id)} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">CPU and RAM per session are best effort (matched by working directory); per-environment numbers above are reliable.</p>
      </section>

      <ul className="note" style={{ margin: 0, paddingLeft: 18 }} aria-label="Known limits">
        {dash.limits.map((l) => <li key={l}>{l}</li>)}
      </ul>
      {reattach && (
        <RunDialog<SessionReattachData>
          title={`Reattach session ${reattach.slice(0, 8)}`}
          begin={(h) => client.sessionReattach(reattach, h)}
          terminal={{ kind: 'devhost', args: ['session', 'reattach', reattach] }}
          onClose={() => setReattach(null)}
          after={(r) => r.data && <p>Back on Remote Control: <button className="btn sm" onClick={() => void openClaude(transport, webApps.appFor(r.data!.account), r.data!.url)}>Open in Claude</button></p>}
        >
          <p className="sec">Runs the session's Remote Control again in its worktree, once (after a reboot the environment's service starts a new one, and the old session is left without a machine).</p>
        </RunDialog>
      )}
      {pluginRun && <PluginRunDialog action={pluginRun.action} target={pluginRun.session ? { session: pluginRun.session } : {}} onClose={() => { setPluginRun(null); if (!pluginRun.session) void widgets.refresh(); }} />}
    </div>
  );
}

const STATUS_BADGE = { ok: <Badge tone="good">ok</Badge>, warn: <Badge tone="warn">warning</Badge>, fail: <Badge tone="bad">problem</Badge> } as const;
const FORMAT = { compact, usd, integer: (v: number) => String(Math.round(v)) } as const;

/**
 * Plugins' dashboard part (`devhost plugin widgets`): each plugin's filters, then its cards in
 * order, normal ones side by side, wide ones (charts) across the page.
 */
function PluginWidgets({ filters, widgets, params, accountNames, onParam, actionFor, onAction }: {
  filters: PluginFilter[];
  widgets: PluginWidget[];
  params: Record<string, string>;
  accountNames: string[];
  onParam: (key: string, value: string) => void;
  actionFor: (w: PluginWidget) => PluginActionInfo | undefined;
  onAction: (a: PluginActionInfo) => void;
}) {
  const plugins = [...new Set(widgets.map((w) => w.plugin))];
  return (
    <>
      {plugins.map((plugin) => {
        const mine = filters.filter((f) => f.plugin === plugin);
        // Consecutive normal cards share a grid row; a wide card stands alone.
        const runs: PluginWidget[][] = [];
        for (const w of widgets.filter((x) => x.plugin === plugin)) {
          const last = runs.at(-1);
          if (w.size !== 'wide' && last && last[0]!.size !== 'wide') last.push(w);
          else runs.push([w]);
        }
        return (
          <div key={plugin} className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {mine.length > 0 && (
              <div className="row" role="group" aria-label={`Filters (${plugin})`}>
                {mine.map((f) => {
                  const key = `${f.plugin}.${f.id}`;
                  return f.kind === 'segmented' ? (
                    <Segmented key={key} label={f.label} value={f.value} options={f.options} onChange={(v) => onParam(key, v)} />
                  ) : (
                    <select key={key} className="select" aria-label={f.label} value={params[key] ?? f.value} onChange={(e) => onParam(key, e.target.value)}>
                      <option value="">{f.allLabel ?? 'All'}</option>
                      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  );
                })}
              </div>
            )}
            {runs.map((run) => (
              run[0]!.size === 'wide'
                ? <WidgetCard key={run[0]!.id} w={run[0]!} accountNames={accountNames} action={actionFor(run[0]!)} onAction={onAction} />
                : <div className="grid cols-3" key={run[0]!.id}>{run.map((w) => <WidgetCard key={`${w.plugin}.${w.id}`} w={w} accountNames={accountNames} action={actionFor(w)} onAction={onAction} />)}</div>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** A plugin's card: status, a line, tiles, a meter, a chart, rows, a note and one action. */
function WidgetCard({ w, accountNames, action, onAction }: { w: PluginWidget; accountNames: string[]; action?: PluginActionInfo; onAction: (a: PluginActionInfo) => void }) {
  const [asTable, setAsTable] = useState(false);
  const chart = w.chart;
  const series: Series[] = chart ? chart.series.map((x, i) => ({ key: x.key, label: x.label, color: seriesVar(chart.colorBy === 'account' ? seriesSlot(accountNames, x.key) : i + 1) })) : [];
  const fmt = chart ? FORMAT[chart.format] : compact;
  const label = (ts: number): string => (chart?.axis === 'date' ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const frac = w.meter && w.meter.max > 0 ? w.meter.value / w.meter.max : 0;
  return (
    <section className="card" aria-label={w.account ? `Account ${w.account}` : `${w.title} (${w.plugin})`}>
      <header>
        {w.account && <i style={{ width: 10, height: 10, borderRadius: 2, background: seriesVar(seriesSlot(accountNames, w.account)) }} aria-hidden="true" />}
        <h2>{w.title}</h2>
        {w.status && STATUS_BADGE[w.status]}
        <span className="push row">
          {chart && <button className="btn sm" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)}>{asTable ? 'Show chart' : 'Show as table'}</button>}
          {!w.account && !chart && <span className="note">{w.plugin}</span>}
        </span>
      </header>
      {w.error ? <div className="note" role="alert">Could not be computed: {w.error}</div> : w.summary && <div className="note">{w.summary}</div>}
      {w.tiles && (
        <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(w.tiles.length, 3)}, 1fr)` }}>
          {w.tiles.map((t) => <div className="tile" key={t.label}><span className="label">{t.label}</span><span className="value">{t.value}</span>{t.sub && <span className="sub">{t.sub}</span>}</div>)}
        </div>
      )}
      {w.meter && (
        <div>
          <div className="note">{w.meter.label}</div>
          <div className={`meter ${meterTone(frac)}`} role="meter" aria-valuemin={0} aria-valuemax={w.meter.max} aria-valuenow={Math.min(w.meter.value, w.meter.max)} aria-label={`${w.title}: ${w.meter.label}`}><i style={{ width: `${Math.min(100, frac * 100)}%` }} /></div>
        </div>
      )}
      {chart && (
        <>
          <Legend series={series} />
          {asTable ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th>{series.map((x) => <th className="num" key={x.key}>{x.label}</th>)}</tr></thead>
                <tbody>{chart.points.map((b) => <tr key={b.ts}><td>{label(b.ts)}</td>{series.map((x) => <td className="num" key={x.key}>{fmt(b.values[x.key] ?? 0)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          ) : (
            <StackedColumns buckets={chart.points} series={series} format={fmt} label={label} title={chart.title} {...(chart.height ? { height: chart.height } : {})} />
          )}
        </>
      )}
      {w.rows && (
        <table>
          <tbody>{w.rows.map((r, i) => <tr key={i}><td>{r.label}{r.note && <div className="note">{r.note}</div>}</td><td className="num">{r.value}</td></tr>)}</tbody>
        </table>
      )}
      {w.note && <p className="note">{w.note}</p>}
      {action && <div><button className={`btn sm${action.destructive ? ' danger' : ''}`} onClick={() => onAction(action)}>{action.title}{action.destructive ? '…' : ''}</button></div>}
    </section>
  );
}

function SessionRow({ s, now, dir, portBase, hostName, app, envUrl, actions, onAction, onReattach }: { s: Session; now: number; dir?: string; portBase: number | null; hostName: string; app: string | null; envUrl?: string; actions: PluginActionInfo[]; onAction: (a: PluginActionInfo) => void; onReattach: () => void }) {
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
      <td className="num">{compact(s.tokensToday)}</td>
      <td className="num">{usd(s.costToday)}</td>
      <td className="num">{pct(s.cpuPercent)}</td>
      <td className="num">{bytes(s.rssBytes)}</td>
      <td>
        <Menu
          label="Open"
          items={[
            { label: app ? `claude.ai/code (${app})` : 'claude.ai/code', onSelect: () => void openClaude(transport, app, s.remoteSession ? `https://claude.ai/code/${s.remoteSession}` : envUrl) },
            { label: 'Reattach to Remote Control…', hidden: s.state !== 'ended' || !s.remoteSession, onSelect: onReattach },
            { label: 'Terminal: resume this session', hidden: !dir || s.state === 'ended', onSelect: () => void transport.openTerminal({ kind: 'resume', dir: dir!, sessionId: s.id }) },
            { label: 'Terminal: shell in the environment', hidden: !dir, onSelect: () => void transport.openTerminal({ kind: 'shell', dir: dir! }) },
            { label: 'VS Code (Remote SSH)', hidden: !dir || !tools.code, onSelect: () => void transport.openVscode(dir!) },
            { label: portBase ? `Dev server (port ${portBase})` : 'Dev server', hidden: portBase == null, onSelect: () => void transport.openUrl(`http://${hostName}:${portBase}`) },
            ...actions.map((a) => ({ label: `${a.title}${a.destructive ? '…' : ''}`, danger: a.destructive, hidden: s.state === 'ended', onSelect: () => onAction(a) })),
          ]}
        />
      </td>
    </tr>
  );
}

function Health({ dash, now }: { dash: DashData; now: number }) {
  const h = dash.host;
  const ts = h.tailscale;
  return (
    <section className="card" aria-label="Mac mini health">
      <header>
        <h2>{h.name}</h2>
        {h.online ? <Badge tone="good">online</Badge> : <Badge tone="bad">no recent samples</Badge>}
        <span className="push note">Collector: last sample {ago(dash.collector.lastSampleAt, now)} · telemetry {ago(dash.collector.lastOtelAt, now)}</span>
      </header>
      <div className="grid cols-4">
        <div className="tile"><span className="label">Uptime</span><span className="value">{duration(h.uptimeSeconds)}</span></div>
        <div className="tile"><span className="label">CPU</span><span className="value">{pct(h.cpuPercent)}</span></div>
        <div className="tile"><span className="label">Memory</span><span className="value">{pct(h.memPercent)}</span><span className="sub">of {bytes(h.memTotalBytes)}</span></div>
        <div className="tile"><span className="label">Disk free</span><span className="value">{pct(h.diskFreePercent)}</span><span className="sub">{bytes(h.diskFreeBytes)}</span></div>
        <div className="tile"><span className="label">Docker</span><span className="value">{h.docker === 'up' ? <Badge tone="good">up</Badge> : h.docker === 'down' ? <Badge tone="bad">down</Badge> : <Badge>unknown</Badge>}</span></div>
        <div className="tile"><span className="label">Tailscale</span><span className="value">{ts ? (ts.state === 'Running' ? <Badge tone="good">running</Badge> : <Badge tone="warn">{ts.state}</Badge>) : <Badge>unknown</Badge>}</span><span className="sub">{ts?.dnsName ?? ''}</span></div>
      </div>
    </section>
  );
}
