import { useEffect, useRef, useState } from 'react';
import type { DashData } from '@devhost/contract/lite';
import { useApp } from './app-context';
import type { Range } from './client/client';
import { UnreachableError } from './client/errors';

export interface DashFilters {
  account?: string;
  env?: string;
  model?: string;
}

/**
 * Live dashboard data: one snapshot right away (fast first paint), then the `dash --follow`
 * stream. The previous snapshot stays on screen while a new range or filter loads and while the
 * connection is down (the frame is kept; `stale` says so).
 */
export function useDash(range: Range, filters: DashFilters, restartMs = 3000) {
  const { client, connection, reportUnreachable } = useApp();
  const connected = connection.kind === 'connected';
  const [dash, setDash] = useState<DashData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = `${range}|${filters.account ?? ''}|${filters.env ?? ''}|${filters.model ?? ''}`;
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let cancel: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);

    const begin = (): void => {
      const follow = client.follow(range, filters, (d) => {
        if (stopped || latest.current !== key) return;
        setDash(d);
        setError(null);
        setLoading(false);
      });
      cancel = follow.cancel;
      follow.promise
        .then((r) => {
          if (stopped) return;
          if (!r.ok && r.errors[0] && r.errors[0].code !== 'cancelled') setError(r.errors[0].message);
          if (!stopped) timer = setTimeout(begin, restartMs);
        })
        .catch((e) => {
          if (stopped) return;
          reportUnreachable(e);
          if (!(e instanceof UnreachableError)) setError(e instanceof Error ? e.message : String(e));
        });
    };

    client
      .dash(range, filters)
      .then((d) => {
        if (stopped) return;
        setDash(d);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (stopped) return;
        reportUnreachable(e);
        setLoading(false);
        if (!(e instanceof UnreachableError)) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!stopped) begin();
      });

    return () => {
      stopped = true;
      cancel?.();
      if (timer) clearTimeout(timer);
    };
    // `key` covers range and filters
  }, [client, connected, key, restartMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return { dash, error, loading, stale: !connected };
}
