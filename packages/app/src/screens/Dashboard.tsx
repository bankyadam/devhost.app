import { useEffect, useState } from 'react';
import type { DashData } from '@devhost/contract/lite';
import { seriesSlot, seriesVar } from '../lib/colors';
import { ago, bytes, compact, duration, pct, usd } from '../lib/format';
import { meterTone } from '../lib/usage';
import { Legend, StackedColumns, type Series } from '../ui/chart';
import { Badge, Empty, Info, Segmented } from '../ui/primitives';
import { UpdateClaude } from '../ui/update-claude';
import { useDash } from '../use-dash';
import { PluginRunDialog } from '../ui/plugin-run';
import { usePlugins, usePluginWidgets, type PluginActionInfo, type PluginFilter, type PluginWidget } from '../use-plugins';

export function Dashboard({ params = {}, onParams = () => undefined }: { params?: Record<string, string>; onParams?: (p: Record<string, string>) => void }) {
  const [known, setKnown] = useState<string[]>([]);

  // Health and alerts: the statistics (and their filters) are the stats plugin's.
  const { dash, loading, error, stale } = useDash('24h', {});
  const plugins = usePlugins();
  const widgets = usePluginWidgets(params);
  const [pluginRun, setPluginRun] = useState<PluginActionInfo | null>(null);
  const [update, setUpdate] = useState(false);

  // Account colors follow the account, not its rank: remember every account ever seen, in order.
  useEffect(() => {
    if (dash) setKnown((k) => [...k, ...dash.accounts.map((a) => a.name).filter((n) => !k.includes(n))]);
  }, [dash]);

  const now = dash?.generatedAt ?? Date.now();

  if (!dash) {
    return <div className="content"><h1>Dashboard</h1><Empty>{error ? `Could not load the dashboard: ${error}` : loading ? 'Loading the dashboard…' : 'No data yet.'}</Empty></div>;
  }

  const accountNames = known.length > 0 ? known : dash.accounts.map((a) => a.name);
  const waiting = dash.sessions.filter((s) => s.state === 'waiting').length;

  return (
    <div className="content" style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="row">
        <h1>Dashboard</h1>
        {waiting > 0 && <Badge tone="warn">{waiting} waiting for input</Badge>}
        {stale && <Badge tone="warn">showing the last data</Badge>}
        {error && <span className="note" role="alert">{error}</span>}
      </div>

      <Health dash={dash} now={now} onUpdate={() => setUpdate(true)} />

      <PluginWidgets
        filters={widgets.filters}
        widgets={widgets.widgets}
        params={params}
        accountNames={accountNames}
        onParam={(key, value) => onParams({ ...params, [key]: value })}
        actionFor={(w) => (w.action ? plugins.action(w.plugin, w.action) : undefined)}
        onAction={setPluginRun}
      />

      {dash.alerts.length > 0 && (
        <div className="notice bad" role="alert">
          {dash.alerts.map((a) => (
            <div key={a.id}><b>{a.id.split(':')[0]}</b>: {a.message}</div>
          ))}
        </div>
      )}

      <ul className="note" style={{ margin: 0, paddingLeft: 18 }} aria-label="Known limits">
        {dash.limits.map((l) => <li key={l}>{l}</li>)}
      </ul>
      {update && <UpdateClaude latest={dash.updates?.claude.latest ?? null} onClose={() => setUpdate(false)} />}
      {pluginRun && <PluginRunDialog action={pluginRun} target={{}} onClose={() => { setPluginRun(null); void widgets.refresh(); }} />}
    </div>
  );
}

const STATUS_BADGE = { ok: <Badge tone="good">ok</Badge>, warn: <Badge tone="warn">warning</Badge>, fail: <Badge tone="bad">problem</Badge> } as const;
const FORMAT = { compact, usd, integer: (v: number) => String(Math.round(v)), percent: (v: number) => `${Math.round(v)}%` } as const;

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

/** A plugin's card: status, a line, tiles, a meter, a chart, rows and one action; its note and each row's are behind an (i). */
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
        {w.note && <Info text={w.note} label={`About ${w.title}`} />}
        {w.status && STATUS_BADGE[w.status]}
        <span className="push row">
          {chart && <button className="btn sm" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)}>{asTable ? 'Show chart' : 'Show as table'}</button>}
          {!w.account && !chart && <span className="note">{w.plugin}</span>}
        </span>
      </header>
      {w.error ? <div className="note" role="alert">Could not be computed: {w.error}</div> : w.summary && <div className="note">{w.summary}</div>}
      {w.tiles && (
        <div className="grid tiles">
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
        <dl className="widget-rows">
          {w.rows.map((r, i) => <div key={i}><dt>{r.label}{r.note && <Info text={r.note} label={`Details of ${r.label}`} />}</dt><dd className="num">{r.value}</dd></div>)}
        </dl>
      )}
      {action && <div><button className={`btn sm${action.destructive ? ' danger' : ''}`} onClick={() => onAction(action)}>{action.title}{action.destructive ? '…' : ''}</button></div>}
    </section>
  );
}

function Health({ dash, now, onUpdate }: { dash: DashData; now: number; onUpdate: () => void }) {
  const u = dash.updates;
  const h = dash.host;
  const ts = h.tailscale;
  return (
    <section className="card" aria-label="Host health">
      <header>
        <h2>{h.name}</h2>
        {h.online ? <Badge tone="good">online</Badge> : <Badge tone="bad">no recent samples</Badge>}
        <span className="push note">Collector: last sample {ago(dash.collector.lastSampleAt, now)} · telemetry {ago(dash.collector.lastOtelAt, now)}</span>
      </header>
      <div className="grid tiles">
        <div className="tile"><span className="label">Uptime</span><span className="value">{duration(h.uptimeSeconds)}</span></div>
        <div className="tile"><span className="label">CPU</span><span className="value">{pct(h.cpuPercent)}</span></div>
        <div className="tile"><span className="label">Memory</span><span className="value">{pct(h.memPercent)}</span><span className="sub">of {bytes(h.memTotalBytes)}</span></div>
        <div className="tile"><span className="label">Disk free</span><span className="value">{pct(h.diskFreePercent)}</span><span className="sub">{bytes(h.diskFreeBytes)}</span></div>
        <div className="tile"><span className="label">Docker</span><span className="value">{h.docker === 'up' ? <Badge tone="good">up</Badge> : h.docker === 'down' ? <Badge tone="bad">down</Badge> : <Badge>unknown</Badge>}</span></div>
        {dash.volume && (
          <div className="tile" aria-label="Work volume"><span className="label">Work volume</span><span className="value">{dash.volume.ready ? <Badge tone="good">{dash.volume.label}</Badge> : <Badge tone="bad">{dash.volume.mounted ? 'not the configured volume' : 'not mounted'}</Badge>}</span><span className="sub">{dash.volume.freePct == null ? '' : `${dash.volume.freePct.toFixed(0)}% free · ${bytes(dash.volume.freeBytes)}`}{dash.volume.encrypted ? ' · encrypted' : ''}</span></div>
        )}
        {u && (
          <div className="tile" aria-label="Claude Code">
            <span className="label">Claude Code <Info label="About the Claude Code version" text={`${u.claude.outdated ? (u.mode === 'auto' ? `Automatic update${u.waiting ? ` waits: ${u.waiting}` : ' soon'}` : 'Automatic update is off') : u.lastUpdate ? `${u.lastUpdate.message} (${ago(u.lastUpdate.at, now)})` : `Checked ${ago(u.checkedAt, now)}`}${u.packages > 0 ? ` · ${u.packages} other package(s) outdated` : ''}`} /></span>
            <span className="value">{u.claude.installed ?? '–'} {u.claude.outdated ? <Badge tone="warn">{u.claude.latest} available</Badge> : u.lastUpdate && !u.lastUpdate.ok ? <Badge tone="bad">update failed</Badge> : <Badge tone="good">current</Badge>}</span>
            {(u.claude.outdated || (u.lastUpdate && !u.lastUpdate.ok)) && <button className="btn sm" onClick={onUpdate}>Update now…</button>}
          </div>
        )}
        <div className="tile"><span className="label">Tailscale</span><span className="value">{ts ? (ts.state === 'Running' ? <Badge tone="good">running</Badge> : <Badge tone="warn">{ts.state}</Badge>) : <Badge>unknown</Badge>}</span><span className="sub">{ts?.dnsName ?? ''}</span></div>
      </div>
    </section>
  );
}
