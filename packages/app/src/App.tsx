import { useCallback, useEffect, useState } from 'react';
import { AppProvider, useApp, type Screen } from './app-context';
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs';
import { Accounts } from './screens/Accounts';
import { Agents } from './screens/Agents';
import { Configuration } from './screens/Configuration';
import { Dashboard } from './screens/Dashboard';
import { Doctor } from './screens/Doctor';
import { Environments } from './screens/Environments';
import { Sessions } from './screens/Sessions';
import { Logs } from './screens/Logs';
import { Monitor } from './screens/Monitor';
import type { Transport } from './transport/types';
import { Badge, ConfirmDialog, Field } from './ui/primitives';
import { Plugins } from './screens/Plugins';
import { StorageScreen } from './screens/Storage';
import { useTraySync } from './use-tray';

const NAV: { id: Screen; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'environments', label: 'Environments' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'agents', label: 'Agents' },
  { id: 'storage', label: 'Storage' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'logs', label: 'Logs' },
];

export interface AppProps {
  /** Builds the transport for a host name (the Rust shell in the app, a demo in a browser). */
  makeTransport: (host: string) => Transport;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  retryMs?: number;
  heartbeatMs?: number;
  /** `monitor`: the monitor window the menu bar opens, only the session cards (spec B3.1.2). */
  view?: 'main' | 'monitor';
}

export function App({ makeTransport, storage, retryMs, heartbeatMs, view = 'main' }: AppProps) {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(storage));
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [transport, setTransport] = useState<Transport | null>(() => (prefs.host ? makeTransport(prefs.host) : null));
  // Pre-fills the host form after "Change host…", so a typo is a quick fix.
  const [lastHost, setLastHost] = useState(prefs.host);

  const update = useCallback(
    (p: Partial<Prefs>) => {
      setPrefs((old) => {
        const next = { ...old, ...p };
        savePrefs(next, storage);
        return next;
      });
    },
    [storage],
  );
  const changeHost = (host: string): void => {
    if (host) setLastHost(host);
    update({ host });
    setTransport(host ? makeTransport(host) : null);
  };

  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prefs.theme);
  }, [prefs.theme]);

  return (
    <AppProvider transport={transport} navigate={setScreen} retryMs={retryMs} heartbeatMs={heartbeatMs}>
      {transport ? view === 'monitor' ? <MonitorWindow /> : <Shell prefs={prefs} update={update} screen={screen} setScreen={setScreen} onHost={changeHost} /> : <HostSetup initial={lastHost} onConnect={changeHost} />}
    </AppProvider>
  );
}

function MonitorWindow() {
  const { connection, hostName } = useApp();
  return (
    <div className="monitor-window">
      {connection.kind === 'unreachable' && <div className="banner bad" role="alert"><b>{hostName} is unreachable.</b> Trying again every few seconds.</div>}
      {connection.kind === 'incompatible' ? <div className="banner bad" role="alert">The devhost on {hostName} does not match this app; open the main window for details.</div> : <Monitor />}
    </div>
  );
}

function HostSetup({ initial, onConnect }: { initial: string; onConnect: (host: string) => void }) {
  const [host, setHost] = useState(initial);
  return (
    <div className="content" style={{ margin: '10vh auto', maxWidth: 520 }}>
      <h1>Connect to your devhost</h1>
      <p className="sec">devhost Desktop talks to the host running devhost with your system <code>ssh</code>, over Tailscale. It uses your <code>~/.ssh/config</code>, agent and keys as they are; it stores only this host name.</p>
      <form className="card" onSubmit={(e) => { e.preventDefault(); if (host.trim()) onConnect(host.trim()); }}>
        <Field label="Host" hint="A name from ~/.ssh/config, a MagicDNS name such as macmini.tail1234.ts.net, or user@host.">
          {(id) => <input id={id} className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="macmini" autoFocus autoComplete="off" spellCheck={false} />}
        </Field>
        <div><button className="btn primary" type="submit" disabled={!host.trim()}>Connect</button></div>
      </form>
    </div>
  );
}

function Shell({ prefs, update, screen, setScreen, onHost }: { prefs: Prefs; update: (p: Partial<Prefs>) => void; screen: Screen; setScreen: (s: Screen) => void; onHost: (h: string) => void }) {
  const { connection, transport, hostName } = useApp();
  const tray = useTraySync();
  // Not window.confirm: the macOS webview (WKWebView under Tauri v2) has no native dialog for it and returns false.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(
    () =>
      transport.onNavigate((s) => {
        if (NAV.some((n) => n.id === s)) setScreen(s as Screen);
      }),
    [transport, setScreen],
  );

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><span aria-hidden="true">▸_</span> devhost</div>
        {NAV.map((n) => (
          <button key={n.id} className="nav" aria-current={screen === n.id ? 'page' : undefined} onClick={() => setScreen(n.id)}>
            {n.label}
            {n.id === 'dashboard' && tray.waiting > 0 && <span className="count" aria-label={`${tray.waiting} sessions waiting`}>{tray.waiting}</span>}
          </button>
        ))}
        <div className="spacer" />
        <button className="nav" onClick={() => setConfirmDisconnect(true)}>Change host…</button>
      </nav>
      {confirmDisconnect && (
        <ConfirmDialog title="Change host" confirmLabel="Disconnect" onConfirm={() => onHost('')} onCancel={() => setConfirmDisconnect(false)}>
          <p>Disconnect from <span className="mono">{transport.host}</span>? Nothing changes on that host; you can connect to it or another host next.</p>
        </ConfirmDialog>
      )}
      <div className="main">
        <header className="topbar">
          <span className="mono">{transport.host}</span>
          {connection.kind === 'connected' && <Badge tone="good">connected · devhost {connection.version.cliVersion}</Badge>}
          {connection.kind === 'connecting' && <Badge>connecting…</Badge>}
          {connection.kind === 'unreachable' && <Badge tone="bad">unreachable</Badge>}
          {connection.kind === 'incompatible' && <Badge tone="bad">incompatible version</Badge>}
          <span style={{ marginLeft: 'auto' }}>
            <select className="select" aria-label="Theme" value={prefs.theme} onChange={(e) => update({ theme: e.target.value as Prefs['theme'] })}>
              <option value="system">System theme</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </span>
        </header>
        {connection.kind === 'unreachable' && (
          <div className="banner bad" role="alert">
            <b>{hostName} is unreachable.</b> {connection.message} Trying again every few seconds; the last data stays visible and everything resumes when it is back.
          </div>
        )}
        {connection.kind === 'incompatible' && <div className="banner bad" role="alert">{connection.message}</div>}
        {connection.kind === 'incompatible' ? null : screen === 'dashboard' ? (
          <Dashboard params={prefs.pluginParams} onParams={(pluginParams) => update({ pluginParams })} />
        ) : screen === 'sessions' ? (
          <Sessions qr={prefs.qrCodes} onQr={(qrCodes) => update({ qrCodes })} />
        ) : screen === 'environments' ? (
          <Environments qr={prefs.qrCodes} onQr={(qrCodes) => update({ qrCodes })} />
        ) : screen === 'accounts' ? (
          <Accounts />
        ) : screen === 'agents' ? (
          <Agents />
        ) : screen === 'storage' ? (
          <StorageScreen />
        ) : screen === 'plugins' ? (
          <Plugins />
        ) : screen === 'configuration' ? (
          <Configuration />
        ) : screen === 'logs' ? (
          <Logs />
        ) : (
          <Doctor />
        )}
      </div>
    </div>
  );
}
