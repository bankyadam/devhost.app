import { useState } from 'react';
import { Badge, Empty } from '../ui/primitives';
import { PluginRunDialog } from '../ui/plugin-run';
import { usePlugins, type PluginActionInfo } from '../use-plugins';

const SCOPE = { host: 'Host', environment: 'In each environment\'s "…" menu', session: "In each session's Open menu" } as const;

/** Plugins on the host: what they are, and their host actions (environment and session ones live in those menus). */
export function Plugins() {
  const { plugins, loaded } = usePlugins();
  const [run, setRun] = useState<{ action: PluginActionInfo; dryRun: boolean } | null>(null);
  return (
    <div className="content">
      <div className="row"><h1>Plugins</h1></div>
      <p className="sec">devhost plugins run on the Mac mini: the built-in ones and those in <span className="mono">~/.config/devhost/plugins</span> (enable them under <span className="mono">plugins</span> in the configuration).</p>
      {plugins.length === 0 ? <section className="card"><Empty>{loaded ? 'No plugins on this host (or it runs a devhost without plugin support).' : 'Loading…'}</Empty></section> : plugins.map((p) => (
        <section className="card" key={p.name} aria-label={`Plugin ${p.name}`}>
          <header className="row">
            <h2>{p.name}</h2>
            {p.version && <span className="note mono">{p.version}</span>}
            {p.builtin && <Badge>built-in</Badge>}
            {p.error ? <Badge tone="bad">does not load</Badge> : p.enabled ? <Badge tone="good">on</Badge> : <Badge>off</Badge>}
          </header>
          {p.description && <p className="sec">{p.description}</p>}
          {p.error && <div className="notice bad">{p.error} <span className="mono">{p.source}</span></div>}
          {p.enabled && !p.error && p.actions.map((a) => (
            <div className="row" key={a.id} style={{ gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <b>{a.title}</b> <span className="note">{a.scope === 'host' ? '' : SCOPE[a.scope]}</span>
                <div className="note">{a.description}</div>
              </div>
              {a.scope === 'host' && (
                <>
                  {a.destructive && <button className="btn sm" onClick={() => setRun({ action: { ...a, plugin: p.name }, dryRun: true })}>Preview</button>}
                  <button className={`btn sm ${a.destructive ? 'danger' : ''}`} onClick={() => setRun({ action: { ...a, plugin: p.name }, dryRun: false })}>{a.destructive ? `${a.title}…` : a.title}</button>
                </>
              )}
            </div>
          ))}
        </section>
      ))}
      {run && <PluginRunDialog action={run.action} target={{}} dryRun={run.dryRun} onClose={() => setRun(null)} />}
    </div>
  );
}
