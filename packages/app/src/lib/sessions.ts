import type { DashData } from '@devhost/contract/lite';

export type Session = DashData['sessions'][number];
export type SortKey = 'account' | 'env' | 'id' | 'state' | 'startedAt' | 'lastActivityAt' | 'tokensToday' | 'costToday' | 'cpuPercent' | 'rssBytes';
export type SortDir = 'asc' | 'desc';

const STATE_ORDER: Record<Session['state'], number> = { waiting: 0, running: 1, idle: 2, ended: 3 };

/** Sessions waiting for input first (they need a human), then by the chosen column. Nulls sort last. */
export function sortSessions(sessions: Session[], key: SortKey, dir: SortDir): Session[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (s: Session): string | number | null => (key === 'state' ? STATE_ORDER[s.state] : (s[key] ?? null));
  return [...sessions].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return c * sign;
  });
}

export const STATE_LABEL: Record<Session['state'], string> = {
  running: 'running',
  waiting: 'waiting for input',
  idle: 'idle',
  ended: 'ended',
};
