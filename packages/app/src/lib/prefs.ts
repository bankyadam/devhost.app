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

const WEB_APPS_KEY = 'devhost.webApps.v1';

/** Which Safari web app is which account's, when it is not named `Claude – <account>` (a UI preference too). */
export function loadWebAppChoices(storage: Pick<Storage, 'getItem'> = localStorage): Record<string, string> {
  try {
    const raw = storage.getItem(WEB_APPS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'string')) as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function saveWebAppChoices(choices: Record<string, string>, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(WEB_APPS_KEY, JSON.stringify(choices));
  } catch {
    /* does not persist */
  }
}

export function savePrefs(p: Prefs, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify({ host: p.host, theme: p.theme, range: p.range }));
  } catch {
    /* private mode etc.: preferences just do not persist */
  }
}
