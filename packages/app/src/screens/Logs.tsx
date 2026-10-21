import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EnvListData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { seriesSlot, seriesVar } from '../lib/colors';
import { Empty } from '../ui/primitives';
import { byAccount, LogPane } from './Environments';

type Source = { id: string; label: string };

/** The collector's and every Remote Control service's log, picked on the left and followed on the right (spec B3.5). */
export function Logs() {
  const { client, connection, reportUnreachable } = useApp();
  const [envs, setEnvs] = useState<EnvListData['environments'] | null>(null);
  const [accountOrder, setAccountOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Source>({ id: 'collector', label: 'Collector' });

  const refresh = useCallback(async () => {
    try {
      const [e, a] = await Promise.all([client.envs(), client.accounts()]);
      setEnvs(e.environments);
      setAccountOrder(a.accounts.map((x) => x.name));
      setError(null);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    }
  }, [client, reportUnreachable]);
  useEffect(() => {
    if (connection.kind === 'connected') void refresh();
  }, [connection.kind, refresh]);

  const rc = (envs ?? []).filter((e) => e.remoteControl.enabled);
  const load = useMemo(
    () => (selected.id === 'collector' ? () => client.collectorLogs(300).then((l) => l.lines) : () => client.envLogs(selected.id.slice(3), 300).then((l) => l.lines)),
    [client, selected.id],
  );
  const pick = (s: Source) => (
    <button key={s.id} className="nav" aria-current={selected.id === s.id ? "true" : undefined} onClick={() => setSelected(s)}>{s.label}</button>
  );

  return (
    <div className="content">
      <h1>Logs</h1>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <div className="logs-layout">
        <nav className="card log-sources" aria-label="Log sources">
          <div className="label">devhost</div>
          {pick({ id: 'collector', label: 'Collector' })}
          {envs === null ? <Empty>Loading…</Empty> : byAccount(rc, accountOrder).map(([account, list]) => (
            <div key={account}>
              <div className="label row">
                <i style={{ width: 10, height: 10, borderRadius: 2, background: seriesVar(seriesSlot(accountOrder, account)) }} aria-hidden="true" />
                {account}
              </div>
              {list.map((e) => pick({ id: `rc:${e.name}`, label: e.name }))}
            </div>
          ))}
        </nav>
        <section className="card log-main" aria-label={`${selected.label} log`}>
          <header><h2>{selected.id === 'collector' ? 'Collector' : `${selected.label} · Remote Control`}</h2></header>
          <LogPane load={load} />
        </section>
      </div>
    </div>
  );
}
