import { useCallback, useEffect, useState } from 'react';
import type { DoctorData, EnvListData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { Badge, CopyButton } from '../ui/primitives';
import { LogViewer } from './Environments';

const SYMBOL = { ok: '✅', warn: '⚠️', fail: '❌' } as const;

/** Doctor as a checklist with fix hints (copy-to-clipboard), plus the log viewer (spec B3.5). */
export function Doctor() {
  const { client, connection, reportUnreachable } = useApp();
  const [data, setData] = useState<DoctorData | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envs, setEnvs] = useState<EnvListData['environments']>([]);
  const [log, setLog] = useState<null | { title: string; load: () => Promise<string[]> }>(null);

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
    void client.envs().then((e) => setEnvs(e.environments)).catch(() => undefined);
  }, [client, connection.kind, run]);

  return (
    <div className="content">
      <div className="row">
        <h1>Doctor and logs</h1>
        <span style={{ marginLeft: 'auto' }}><button className="btn" disabled={running} onClick={() => void run()}>{running ? 'Checking…' : 'Run checks again'}</button></span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <section className="card" aria-label="Checks">
        {data && (
          <div className="row">
            <Badge tone="good">{data.summary.ok} ok</Badge>
            <Badge tone={data.summary.warn > 0 ? 'warn' : 'none'}>{data.summary.warn} warnings</Badge>
            <Badge tone={data.summary.fail > 0 ? 'bad' : 'none'}>{data.summary.fail} failed</Badge>
          </div>
        )}
        {!data ? <div className="empty">{running ? 'Running the checks on the Mac mini…' : 'No result yet.'}</div> : (
          <div className="checklist">
            {data.checks.map((c) => (
              <div className="item" key={c.id}>
                <span aria-label={c.status}>{SYMBOL[c.status]}</span>
                <div>
                  <div><span className="id">{c.id}</span> {c.message}</div>
                  {c.fix && c.status !== 'ok' && <div className="note">Fix: <code>{c.fix}</code></div>}
                </div>
                {c.fix && c.status !== 'ok' && <CopyButton text={c.fix} label="Copy fix" />}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card" aria-label="Logs">
        <header><h2>Logs</h2></header>
        <div className="row">
          <button className="btn" onClick={() => setLog({ title: 'Collector log', load: () => client.collectorLogs(300).then((l) => l.lines) })}>Collector</button>
          {envs.filter((e) => e.remoteControl.enabled).map((e) => (
            <button key={e.name} className="btn" onClick={() => setLog({ title: `${e.name} · Remote Control log`, load: () => client.envLogs(e.name, 300).then((l) => l.lines) })}>{e.account}/{e.name}</button>
          ))}
        </div>
      </section>
      {log && <LogViewer title={log.title} load={log.load} onClose={() => setLog(null)} />}
    </div>
  );
}
