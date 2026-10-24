import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { VersionData } from '@devhost/contract/lite';
import { DevhostClient } from './client/client';
import { IncompatibleError, UnreachableError, errorMessage } from './client/errors';
import type { Transport } from './transport/types';

export type Connection =
  | { kind: 'no-host' }
  | { kind: 'connecting' }
  | { kind: 'connected'; version: VersionData }
  | { kind: 'unreachable'; since: number; message: string }
  | { kind: 'incompatible'; message: string };

export interface AppCtx {
  client: DevhostClient;
  transport: Transport;
  connection: Connection;
  /** Screens call this when a command failed because the host could not be reached. */
  reportUnreachable: (e: unknown) => void;
  navigate: (screen: Screen) => void;
  tools: { code: boolean; iterm: boolean };
  /** The host's name as devhost reports it (`version` → host.name); the ssh host until it has answered. */
  hostName: string;
}

export type Screen = 'dashboard' | 'environments' | 'accounts' | 'agents' | 'storage' | 'plugins' | 'configuration' | 'doctor' | 'logs';

const Ctx = createContext<AppCtx | null>(null);
export const useApp = (): AppCtx => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside of <AppProvider>');
  return v;
};

export interface ProviderProps {
  transport: Transport | null;
  navigate: (screen: Screen) => void;
  /** Time between connection attempts while unreachable, and between heartbeats while connected. */
  retryMs?: number;
  heartbeatMs?: number;
  children: ReactNode;
}

/**
 * Connects, checks the contract version (spec B2) and keeps checking: an unreachable host is
 * shown as such and the app recovers by itself when it returns (spec B6).
 */
export function AppProvider({ transport, navigate, retryMs = 4000, heartbeatMs = 15000, children }: ProviderProps) {
  const client = useMemo(() => (transport ? new DevhostClient(transport) : null), [transport]);
  const [connection, setConnection] = useState<Connection>(transport ? { kind: 'connecting' } : { kind: 'no-host' });
  const [tools, setTools] = useState({ code: false, iterm: false });
  const [reported, setReported] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!client || !transport) {
      setConnection({ kind: 'no-host' });
      return;
    }
    setConnection({ kind: 'connecting' });
    let timer: ReturnType<typeof setTimeout>;
    let first = true;

    const check = async (): Promise<void> => {
      try {
        const version = await client.version();
        if (!alive.current) return;
        if (version.host?.name) setReported(version.host.name);
        setConnection((c) => (c.kind === 'connected' && c.version.cliVersion === version.cliVersion ? c : { kind: 'connected', version }));
        timer = setTimeout(() => void check(), heartbeatMs);
        if (first) {
          first = false;
          void transport.detectTools().then((t) => alive.current && setTools(t)).catch(() => undefined);
        }
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof IncompatibleError) {
          setConnection({ kind: 'incompatible', message: e.message });
          return; // retrying cannot fix a version mismatch
        }
        setConnection((c) => (c.kind === 'unreachable' ? c : { kind: 'unreachable', since: Date.now(), message: e instanceof UnreachableError ? e.message : errorMessage(e) }));
        timer = setTimeout(() => void check(), retryMs);
      }
    };
    void check();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [client, transport, retryMs, heartbeatMs]);

  const reportUnreachable = useCallback((e: unknown) => {
    if (e instanceof UnreachableError) setConnection((c) => (c.kind === 'unreachable' ? c : { kind: 'unreachable', since: Date.now(), message: e.message }));
  }, []);

  const hostName = reported ?? transport?.host.replace(/^.*@/, '') ?? 'the host';
  const value = useMemo<AppCtx | null>(
    () => (client && transport ? { client, transport, connection, reportUnreachable, navigate, tools, hostName } : null),
    [client, transport, connection, reportUnreachable, navigate, tools, hostName],
  );
  if (!value) return <>{children}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
