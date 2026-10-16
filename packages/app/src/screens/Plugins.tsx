import { useState } from 'react';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { Badge, ConfirmDialog, Dialog, Empty, Field } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';
import { PluginRunDialog } from '../ui/plugin-run';
import { usePlugins, type PluginActionInfo } from '../use-plugins';

const SCOPE = { host: 'Host', environment: 'In each environment\'s "…" menu', session: "In each session's Open menu" } as const;

/** Plugins on the host: what they are, and their host actions (environment and session ones live in those menus). */
export function Plugins() {
  const { client } = useApp();
  const { plugins, loaded, refresh } = usePlugins();
  const [run, setRun] = useState<{ action: PluginActionInfo; dryRun: boolean } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (f: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    }
    await refresh();
  };
  return (
    <div className="content">
      <div className="row">
        <h1>Plugins</h1>
        <span style={{ marginLeft: 'auto' }}><button className="btn primary" onClick={() => setInstalling(true)}>Install from GitHub…</button></span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <p className="sec">devhost plugins run on the Mac mini: the built-in ones and those in <span className="mono">~/.config/devhost/plugins</span> (enable them under <span className="mono">plugins</span> in the configuration).</p>
      {plugins.length === 0 ? <section className="card"><Empty>{loaded ? 'No plugins on this host (or it runs a devhost without plugin support).' : 'Loading…'}</Empty></section> : plugins.map((p) => (
        <section className="card" key={p.name} aria-label={`Plugin ${p.name}`}>
          <header className="row">
            <h2>{p.name}</h2>
            {p.version && <span className="note mono">{p.version}</span>}
            {p.builtin && <Badge>built-in</Badge>}
            {p.error ? <Badge tone="bad">does not load</Badge> : p.enabled ? <Badge tone="good">on</Badge> : <Badge>off</Badge>}
            <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
              <button className="btn sm" onClick={() => void change(() => client.pluginToggle(p.name, !p.enabled))}>{p.enabled ? 'Disable' : 'Enable'}</button>
              {!p.builtin && <button className="btn sm danger" onClick={() => setRemoving(p.name)}>Uninstall…</button>}
            </span>
          </header>
          {p.installedFrom && <p className="note mono">{p.installedFrom.url}{p.installedFrom.ref ? `#${p.installedFrom.ref}` : ''}{p.installedFrom.commit ? ` @ ${p.installedFrom.commit.slice(0, 12)}` : ''}</p>}
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
      {installing && <InstallDialog onClose={() => { setInstalling(false); void refresh(); }} />}
      {removing && (
        <ConfirmDialog title={`Uninstall ${removing}?`} confirmLabel="Uninstall" danger onCancel={() => setRemoving(null)} onConfirm={() => { const n = removing; setRemoving(null); void change(() => client.pluginUninstall(n)); }}>
          <p>Removes <span className="mono">~/.config/devhost/plugins/{removing}</span> and its entry in the configuration.</p>
        </ConfirmDialog>
      )}
      {run && <PluginRunDialog action={run.action} target={{}} dryRun={run.dryRun} onClose={() => setRun(null)} />}
    </div>
  );
}

/** A GitHub URL or owner/repo; installed switched off unless "Enable now", since it is someone's code. */
function InstallDialog({ onClose }: { onClose: () => void }) {
  const { client } = useApp();
  const [source, setSource] = useState('');
  const [enable, setEnable] = useState(false);
  const [go, setGo] = useState(false);
  if (go) {
    return (
      <RunDialog title={`Install ${source}`} begin={(h) => client.pluginInstall(source, enable, h)} terminal={{ kind: 'devhost', args: ['plugin', 'install', source, ...(enable ? ['--enable'] : [])] }} onClose={onClose}>
        <p className="sec">Cloning the repository into ~/.config/devhost/plugins on the Mac mini.</p>
      </RunDialog>
    );
  }
  const valid = /^\S+$/.test(source.trim()) && !source.trim().startsWith('-');
  return (
    <Dialog title="Install a plugin" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid} onClick={() => setGo(true)}>Install</button></>}>
      <Field label="GitHub repository" hint="https://github.com/owner/repo, owner/repo, or git@github.com:owner/repo.git; #branch or #tag picks a version.">
        {(id) => <input id={id} className="input" value={source} onChange={(e) => setSource(e.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="owner/devhost-plugin-name" />}
      </Field>
      <label className="check"><input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} /> Enable now</label>
      <div className="notice">A plugin runs code from that repository on the Mac mini as you. Installed, it stays off until you enable it.</div>
    </Dialog>
  );
}
