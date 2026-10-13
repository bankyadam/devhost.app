import { useEffect, useState } from 'react';
import type { DashData, EnvListData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import type { Range } from '../client/client';
import { seriesSlot, seriesVar } from '../lib/colors';
import { ago, bytes, compact, duration, pct, usd } from '../lib/format';
import { filterSessions, sortSessions, STATE_LABEL, type Session, type SortDir, type SortKey } from '../lib/sessions';
import { bucketLabel, buildBuckets, meterTone, TOKEN_TYPES, type Metric, type Stack } from '../lib/usage';
import { Legend, StackedColumns, type Series } from '../ui/chart';
import { Badge, Empty, Menu, Segmented } from '../ui/primitives';
import { useDash } from '../use-dash';
import { openClaude, useWebApps } from '../use-web-apps';

const RANGES: { value: Range; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export function Dashboard({ range, onRange }: { range: Range; onRange: (r: Range) => void }) {
  const { client, transport, connection } = useApp();
  const [account, setAccount] = useState('');
  const [env, setEnv] = useState('');
  const [model, setModel] = useState('');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [stack, setStack] = useState<Stack>('account');
  const [asTable, setAsTable] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'lastActivityAt', dir: 'desc' });
  const [known, setKnown] = useState<string[]>([]);
  const [envs, setEnvs] = useState<EnvListData['environments']>([]);

  const { dash, loading, error, stale } = useDash(range, { account, env, model });
  const webApps = useWebApps(known);

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
  const visibleAccounts = dash.accounts.map((a) => a.name);
  const sessions = sortSessions(filterSessions(dash.sessions, {}), sort.key, sort.dir);
  const waiting = dash.sessions.filter((s) => s.state === 'waiting').length;

  const series: Series[] =
    stack === 'account'
      ? visibleAccounts.map((a) => ({ key: a, label: a, color: seriesVar(seriesSlot(accountNames, a)) }))
      : TOKEN_TYPES.map((t, i) => ({ key: t.key, label: t.label, color: seriesVar(i + 1) }));
  const buckets = buildBuckets(dash, metric, stack, visibleAccounts);
  const fmt = metric === 'cost' ? usd : compact;
  const label = bucketLabel(dash.range);

  const envDir = (name: string | null): string | undefined => envs.find((e) => e.name === name)?.dir;

  return (
    <div className="content" style={{ opacity: loading ? 0.6 : 1 }}>
      <div className="row">
        <h1>Dashboard</h1>
        {waiting > 0 && <Badge tone="warn">{waiting} waiting for input</Badge>}
        {stale && <Badge tone="warn">showing the last data</Badge>}
      </div>

      <Health dash={dash} now={now} />

      {dash.alerts.length > 0 && (
        <div className="notice bad" role="alert">
          {dash.alerts.map((a) => (
            <div key={a.id}><b>{a.id.split(':')[0]}</b>: {a.message}</div>
          ))}
        </div>
      )}

      <div className="row" role="group" aria-label="Filters">
        <Segmented label="Time range" value={range} options={RANGES} onChange={onRange} />
        <select className="select" aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accountNames.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="select" aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value)}>
          <option value="">All environments</option>
          {envs.filter((e) => !account || e.account === account).map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
        </select>
        <select className="select" aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">All models</option>
          {dash.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {error && <span className="note" role="alert">{error}</span>}
      </div>

      <div className="grid cols-3">
        {dash.accounts.map((a) => {
          const limit = a.dailyCostAlertUsd;
          const frac = limit ? a.today.costUsd / limit : 0;
          return (
            <div className="card" key={a.name} aria-label={`Account ${a.name}`}>
              <header>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: seriesVar(seriesSlot(accountNames, a.name)) }} aria-hidden="true" />
                <h2>{a.name}</h2>
                <span className="push">{a.loggedIn === false ? <Badge tone="bad">login invalid</Badge> : a.loggedIn ? <Badge tone="good">logged in</Badge> : <Badge>login unknown</Badge>}</span>
              </header>
              <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="tile"><span className="label">Today</span><span className="value">{compact(a.today.tokens)}</span><span className="sub">tokens · ~{usd(a.today.costUsd)}</span></div>
                <div className="tile"><span className="label">This week</span><span className="value">{compact(a.week.tokens)}</span><span className="sub">tokens · ~{usd(a.week.costUsd)}</span></div>
              </div>
              {limit != null && (
                <div>
                  <div className="note">Daily cost alert at {usd(limit)} (estimate)</div>
                  <div className={`meter ${meterTone(frac)}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(a.today.costUsd, limit)} aria-label={`${a.name} cost today against its alert limit`}><i style={{ width: `${Math.min(100, frac * 100)}%` }} /></div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <section className="card" aria-label="Usage">
        <header>
          <h2>{metric === 'tokens' ? 'Tokens' : 'Estimated cost'} over time</h2>
          <span className="push row">
            <Segmented label="Metric" value={metric} options={[{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }]} onChange={(m) => { setMetric(m); if (m === 'cost') setStack('account'); }} />
            <Segmented label="Stack by" value={stack} options={[{ value: 'account', label: 'Account' }, ...(metric === 'tokens' ? [{ value: 'type' as const, label: 'Token type' }] : [])]} onChange={setStack} />
            <button className="btn sm" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)}>{asTable ? 'Show chart' : 'Show as table'}</button>
          </span>
        </header>
        <Legend series={series} />
        {asTable ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th>{series.map((s) => <th className="num" key={s.key}>{s.label}</th>)}</tr></thead>
              <tbody>{buckets.map((b) => <tr key={b.ts}><td>{label(b.ts)}</td>{series.map((s) => <td className="num" key={s.key}>{fmt(b.values[s.key] ?? 0)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : (
          <StackedColumns buckets={buckets} series={series} format={fmt} label={label} title={`${metric === 'tokens' ? 'Tokens' : 'Estimated cost'} per ${dash.range === '1h' ? '5 minutes' : dash.range === '24h' ? 'hour' : dash.range === '7d' ? '6 hours' : 'day'}`} />
        )}
        <p className="note">Cost is an estimate from Claude Code; on a subscription it is API-equivalent value, not billed money. Plan limits are not available.</p>
      </section>

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
                {sessions.map((s) => <SessionRow key={s.id} s={s} now={now} dir={envDir(s.env)} portBase={dash.environments.find((e) => e.name === s.env)?.portBase ?? null} hostName={hostName} webApps={webApps.installed} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">CPU and RAM per session are best effort (matched by working directory); per-environment numbers above are reliable.</p>
      </section>

      <ul className="note" style={{ margin: 0, paddingLeft: 18 }} aria-label="Known limits">
        {dash.limits.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </div>
  );
}

function SessionRow({ s, now, dir, portBase, hostName, webApps }: { s: Session; now: number; dir?: string; portBase: number | null; hostName: string; webApps: Record<string, boolean> }) {
  const { transport, tools } = useApp();
  return (
    <tr className={s.state === 'waiting' ? 'waiting' : ''}>
      <td>{s.account ?? '–'}</td>
      <td>{s.env ?? '–'}</td>
      <td className="mono" title={s.id}>{s.id.slice(0, 8)}</td>
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
            { label: s.account && webApps[s.account] ? `claude.ai/code (Claude – ${s.account})` : 'claude.ai/code', onSelect: () => void openClaude(transport, webApps, s.account) },
            { label: 'Terminal: resume this session', hidden: !dir || s.state === 'ended', onSelect: () => void transport.openTerminal({ kind: 'resume', dir: dir!, sessionId: s.id }) },
            { label: 'Terminal: shell in the environment', hidden: !dir, onSelect: () => void transport.openTerminal({ kind: 'shell', dir: dir! }) },
            { label: 'VS Code (Remote SSH)', hidden: !dir || !tools.code, onSelect: () => void transport.openVscode(dir!) },
            { label: portBase ? `Dev server (port ${portBase})` : 'Dev server', hidden: portBase == null, onSelect: () => void transport.openUrl(`http://${hostName}:${portBase}`) },
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
