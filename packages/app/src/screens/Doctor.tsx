import { useCallback, useEffect, useState } from 'react';
import type { DoctorData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { Badge, CopyButton, Segmented } from '../ui/primitives';
import { PluginRunDialog } from '../ui/plugin-run';
import { usePlugins, type PluginActionInfo } from '../use-plugins';

const SYMBOL = { ok: '✅', warn: '⚠️', fail: '❌' } as const;

/** Doctor as a checklist (problems only unless asked, grouped and sorted by id) with fix hints (copy-to-clipboard), (spec B3.5); the logs have their own screen. */
export function Doctor() {
  const { client, connection, reportUnreachable, hostName } = useApp();
  const [data, setData] = useState<DoctorData | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plugins = usePlugins();
  const [pluginRun, setPluginRun] = useState<PluginActionInfo | null>(null);
  // Problems only by default; grouped by the first part of the id, groups and checks alphabetical.
  const [filter, setFilter] = useState<'problems' | 'all'>('problems');
  const shown = (data?.checks ?? []).filter((c) => filter === 'all' || c.status !== 'ok');
  const byGroup = new Map<string, typeof shown>();
  for (const c of [...shown].sort((a, b) => a.id.localeCompare(b.id))) byGroup.set(c.id.split('.')[0]!, [...(byGroup.get(c.id.split('.')[0]!) ?? []), c]);
  const groups = [...byGroup].sort(([a], [b]) => a.localeCompare(b));

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setData(await client.doctor());
      setError(null);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }, [client, reportUnreachable]);

  useEffect(() => {
    if (connection.kind !== 'connected') return;
    void run();
  }, [connection.kind, run]);

  return (
    <div className="content">
      <div className="row">
        <h1>Doctor</h1>
        <span style={{ marginLeft: 'auto' }}><button className="btn" disabled={running} onClick={() => void run()}>{running ? 'Checking…' : 'Run checks again'}</button></span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <section className="card" aria-label="Checks">
        {data && (
          <div className="row">
            <Badge tone="good">{data.summary.ok} ok</Badge>
            <Badge tone={data.summary.warn > 0 ? 'warn' : 'none'}>{data.summary.warn} warnings</Badge>
            <Badge tone={data.summary.fail > 0 ? 'bad' : 'none'}>{data.summary.fail} failed</Badge>
            <span className="push"><Segmented label="Show" value={filter} options={[{ value: 'problems', label: 'Problems' }, { value: 'all', label: 'All checks' }]} onChange={setFilter} /></span>
          </div>
        )}
        {!data ? <div className="empty">{running ? `Running the checks on ${hostName}…` : 'No result yet.'}</div> : shown.length === 0 ? (
          <div className="empty">Every check is OK.</div>
        ) : (
          groups.map(([group, checks]) => (
            <div className="check-group" key={group} role="group" aria-label={`${group} checks`}>
              <h3>{group}<span className="muted"> · {checks.length}</span></h3>
              <div className="checklist">
                {checks.map((c) => (
                  <div className="item" key={c.id}>
                    <span aria-label={c.status}>{SYMBOL[c.status]}</span>
                    <div>
                      <div><span className="id">{c.id}</span> {c.message}</div>
                      {c.fix && c.status !== 'ok' && <div className="note">Fix: <code>{c.fix}</code></div>}
                      {c.advice?.map((a, i) => {
                        const action = a.action ? plugins.action(a.plugin, a.action) : undefined;
                        return (
                          <div className="note row" key={i} aria-label={`Advice from ${a.plugin}`}>
                            <span><b>{a.plugin}</b>: {a.message}{a.fix && <> · <code>{a.fix}</code></>}</span>
                            {action ? <button className={`btn sm${action.destructive ? ' danger' : ''}`} onClick={() => setPluginRun(action)}>{action.title}{action.destructive ? '…' : ''}</button> : a.fix && <CopyButton text={a.fix} label="Copy" />}
                          </div>
                        );
                      })}
                    </div>
                    {c.fix && c.status !== 'ok' && <CopyButton text={c.fix} label="Copy fix" />}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
      {pluginRun && <PluginRunDialog action={pluginRun} target={{}} onClose={() => { setPluginRun(null); void run(); }} />}
    </div>
  );
}
