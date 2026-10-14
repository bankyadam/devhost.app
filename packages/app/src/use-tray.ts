import { useEffect, useState } from 'react';
import { useApp } from './app-context';
import { trayState, type TrayState } from './lib/tray';

/**
 * Keeps the menu bar item in sync (status in the icon's cursor, sessions waiting for input) and exposes the same
 * numbers to the sidebar. Polls a cheap snapshot, independent of which screen is open.
 */
export function useTraySync(intervalMs = 10_000): TrayState {
  const { client, transport, connection } = useApp();
  const [state, setState] = useState<TrayState>({ status: 'yellow', waiting: 0 });
  const connected = connection.kind === 'connected';

  useEffect(() => {
    let stopped = false;
    const push = (s: TrayState): void => {
      if (stopped) return;
      setState(s);
      void transport.setTray(s.status, s.waiting).catch(() => undefined);
    };
    if (!connected) {
      push(trayState(connection.kind === 'connecting', null));
      return () => void (stopped = true);
    }
    const tick = (): void => {
      client.dash('1h').then((d) => push(trayState(true, d)), () => push(trayState(false, null)));
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [client, transport, connected, connection.kind, intervalMs]);

  return state;
}
