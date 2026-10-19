export interface Prefs {
  host: string;
  theme: 'system' | 'light' | 'dark';
  /** Dashboard plugin filters, `<plugin>.<filter>` → value (e.g. `stats.range`: `7d`). */
  pluginParams: Record<string, string>;
}

const KEY = 'devhost.prefs.v1';
const DEFAULTS: Prefs = { host: '', theme: 'system', pluginParams: {} };

/** The app stores the host name and UI preferences only (spec B2): no credentials, no keys, no telemetry. */
export function loadPrefs(storage: Pick<Storage, 'getItem'> = localStorage): Prefs {
  try {
    const raw = storage.getItem(KEY);
    const stored = (raw ? JSON.parse(raw) : {}) as Partial<Prefs> & { range?: string };
    // The time range was the dashboard's own before the stats plugin took the statistics over.
    const pluginParams = stored.pluginParams ?? (stored.range ? { 'stats.range': stored.range } : {});
    return { host: stored.host ?? DEFAULTS.host, theme: stored.theme ?? DEFAULTS.theme, pluginParams };
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
    storage.setItem(KEY, JSON.stringify({ host: p.host, theme: p.theme, pluginParams: p.pluginParams }));
  } catch {
    /* private mode etc.: preferences just do not persist */
  }
}
