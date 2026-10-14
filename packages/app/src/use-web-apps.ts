import { useCallback, useEffect, useState } from 'react';
import { useApp } from './app-context';
import { loadWebAppChoices, saveWebAppChoices } from './lib/prefs';
import type { Transport } from './transport/types';

export const CLAUDE_CODE_URL = 'https://claude.ai/code';
export const defaultWebAppName = (account: string): string => `Claude – ${account}`;

/** The account's web app: the one chosen for it, else the one named `Claude – <account>`, if it exists. */
export function webAppFor(installed: readonly string[], choices: Record<string, string>, account: string): string | null {
  const name = choices[account] ?? defaultWebAppName(account);
  return installed.includes(name) ? name : null;
}

/**
 * The Safari web apps on this Mac and which one belongs to which account. Each web app keeps its
 * own claude.ai login, so several accounts stay signed in side by side; `refresh` re-reads
 * ~/Applications after a setup.
 */
export function useWebApps() {
  const { transport } = useApp();
  const [installed, setInstalled] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>(() => loadWebAppChoices());
  const refresh = useCallback(async (): Promise<string[]> => {
    try {
      const names = await transport.listWebApps();
      setInstalled(names);
      return names;
    } catch {
      return [];
    }
  }, [transport]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const choose = useCallback((account: string, name: string) => {
    setChoices((c) => {
      const next = { ...c, [account]: name };
      saveWebAppChoices(next);
      return next;
    });
  }, []);
  const appFor = useCallback((account: string) => webAppFor(installed, choices, account), [installed, choices]);
  return { installed, appFor, choose, refresh };
}

/**
 * Claude for an account: `url` (its Remote Control environment, where new sessions start) or
 * claude.ai/code, in the account's web app when it has one, otherwise in the default browser.
 */
export function openClaude(transport: Transport, app: string | null, url?: string): Promise<void> {
  return app ? transport.openWebApp(app, url) : transport.openUrl(url ?? CLAUDE_CODE_URL);
}
