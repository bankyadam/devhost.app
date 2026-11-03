import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './app-context';
import { errorMessage } from './client/errors';

/**
 * A read from the host, loaded when the connection is up and again on `refresh()`: reports an unreachable
 * host, keeps the last data while a reload runs, and ignores an answer that a newer request overtook.
 * `fetcher` must be stable (wrap it in useCallback) or the query reloads on every render.
 */
export function useHostQuery<T>(fetcher: () => Promise<T>) {
  const { connection, reportUnreachable } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const flight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const run = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const d = await fetcher();
      if (!alive.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      reportUnreachable(e);
      setError(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [fetcher, reportUnreachable]);
  /** Single flight: a call during a running load schedules exactly one reload after it, and shares its promise. */
  const refresh = useCallback((): Promise<void> => {
    if (flight.current) {
      again.current = true;
      return flight.current;
    }
    const p = (async () => {
      do {
        again.current = false;
        await run();
      } while (again.current && alive.current);
    })().finally(() => { flight.current = null; });
    flight.current = p;
    return p;
  }, [run]);
  useEffect(() => {
    alive.current = true;
    if (connection.kind === 'connected') void refresh();
    return () => { alive.current = false; };
  }, [connection.kind, refresh]);
  return { data, error, loading, refresh };
}
