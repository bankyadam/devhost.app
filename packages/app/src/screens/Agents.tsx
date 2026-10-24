import { useCallback, useEffect, useState } from 'react';
import type { AgentsListData, DevhostConfig } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { Badge, Empty } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';

type Target = AgentsListData['targets'][number];

/** Where a target's agent list lives in the config (JSON pointer), or null when the config has no such entry. */
export function pointerOf(config: DevhostConfig, t: Target): string | null {
  if (t.scope === 'account') {
    const i = (config.accounts ?? []).findIndex((a) => a.name === t.account);
    return i < 0 ? null : `/accounts/${i}/agents`;
  }
  const i = (config.environments ?? []).findIndex((e) => e.name === t.env && e.account === t.account);
  return i < 0 ? null : `/environments/${i}/agents`;
}

export function Agents() {
  const { client, connection, reportUnreachable } = useApp();
  const [data, setData] = useState<AgentsListData | null>(null);
  const [config, setConfig] = useState<DevhostConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [apply, setApply] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([client.agents(), client.configGet()]);
      setData(d);
      setConfig(c);
      setError(null);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    }
  }, [client, reportUnreachable]);

  useEffect(() => {
    if (connection.kind === 'connected') void refresh();
  }, [connection.kind, refresh]);

  const change = async (pointer: string, value: unknown): Promise<void> => {
    try {
      await client.configSet(pointer, value);
      setPending(true);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const toggle = (t: Target, name: string): void => {
    const pointer = config ? pointerOf(config, t) : null;
    if (!pointer) return;
    const next = t.agents.includes(name) ? t.agents.filter((n) => n !== name) : [...t.agents, name];
    void change(pointer, next);
  };

  return (
    <div className="content">
      <div className="row">
        <h1>Agents</h1>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn primary" disabled={!pending} onClick={() => setApply(true)}>Apply changes</button>
        </span>
      </div>
      <p className="sec">Subagents Claude Code can hand work to: a fresh context for a broad search, a test run or a review. Pick which ones an account or an environment has; the agent files are written to the host when you apply, and sessions that are already running see them after they restart.</p>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {pending && <div className="notice" role="status">The configuration changed: apply it to write the agent files.</div>}
      {data === null ? <Empty>Loading…</Empty> : (
        <>
          <section className="card">
            <h2>Catalog</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Agent</th><th>Use it for</th><th>Model</th><th>Tools</th></tr></thead>
                <tbody>
                  {data.agents.map((a) => (
                    <tr key={a.name}>
                      <td><b>{a.name}</b> {a.builtin ? null : <Badge>custom</Badge>}</td>
                      <td>{a.description}</td>
                      <td className="mono">{a.model ?? 'inherits'}</td>
                      <td className="mono">{a.tools?.join(', ') ?? 'all'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">Define your own under <code>agents.custom</code> in the Configuration.</p>
          </section>

          <section className="card">
            <h2>Delegation rule</h2>
            <label className="row">
              <input type="checkbox" checked={data.delegation} onChange={(e) => void change('/agents/delegation', e.target.checked)} />
              <span>Tell Claude, in each account's CLAUDE.md, when to hand work to subagents (broad searches, test runs, reviews; independent tasks in parallel).</span>
            </label>
          </section>

          <section className="card">
            <h2>Accounts and environments</h2>
            {data.targets.length === 0 ? <Empty>No accounts yet.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Where</th>
                      {data.agents.map((a) => <th key={a.name} className="num">{a.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.targets.map((t) => (
                      <tr key={`${t.account}/${t.env ?? ''}`}>
                        <td>{t.scope === 'account' ? <b>{t.account}</b> : <span>{t.account}/<b>{t.env}</b></span>}<div className="note mono">{t.dir}</div></td>
                        {data.agents.map((a) => (
                          <td key={a.name} className="num">
                            <input type="checkbox" aria-label={`${a.name} for ${t.scope === 'account' ? t.account : `${t.account}/${t.env}`}`} checked={t.agents.includes(a.name)} onChange={() => toggle(t, a.name)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="note">An account's agents are available in all its sessions; an environment's only in that environment.</p>
          </section>
        </>
      )}
      {apply && (
        <RunDialog
          title="Apply agents"
          begin={(h) => client.applyAgents(h)}
          terminal={{ kind: 'devhost', args: ['apply', '--only', 'agents', 'accounts.claude'] }}
          onClose={() => setApply(false)}
          onFinished={(r) => { if (r?.ok) setPending(false); }}
          retry
        />
      )}
    </div>
  );
}
