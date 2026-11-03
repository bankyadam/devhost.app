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
  const seq = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await fetcher();
      if (mine !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      reportUnreachable(e);
      setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fetcher, reportUnreachable]);
  useEffect(() => {
    if (connection.kind === 'connected') void refresh();
    const ref = seq;
    return () => { ref.current++; };
  }, [connection.kind, refresh]);
  return { data, error, loading, refresh };
}
