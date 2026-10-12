import type { Range } from '../client/client';

export interface Prefs {
  host: string;
  theme: 'system' | 'light' | 'dark';
  range: Range;
}

const KEY = 'devhost.prefs.v1';
const DEFAULTS: Prefs = { host: '', theme: 'system', range: '24h' };

/** The app stores the host name and UI preferences only (spec B2): no credentials, no keys, no telemetry. */
export function loadPrefs(storage: Pick<Storage, 'getItem'> = localStorage): Prefs {
  try {
    const raw = storage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Prefs>) : {}) };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(p: Prefs, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify({ host: p.host, theme: p.theme, range: p.range }));
  } catch {
    /* private mode etc.: preferences just do not persist */
  }
}
