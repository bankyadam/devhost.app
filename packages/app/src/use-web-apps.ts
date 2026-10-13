import { useCallback, useEffect, useState } from 'react';
import { useApp } from './app-context';
import type { Transport } from './transport/types';

/**
 * Which accounts have their Safari web app on this Mac. Each web app keeps its own claude.ai
 * login, so several accounts stay signed in side by side; `refresh` re-checks after a setup.
 */
export function useWebApps(accounts: readonly string[]) {
  const { transport } = useApp();
  const key = accounts.join('\n');
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const refresh = useCallback(async (): Promise<Record<string, boolean>> => {
    if (key === '') return {};
    try {
      const r = await transport.webApps(key.split('\n'));
      setInstalled(r);
      return r;
    } catch {
      return {};
    }
  }, [transport, key]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { installed, refresh };
}

/** claude.ai/code for an account: its own web app when it has one, otherwise the default browser. */
export function openClaude(transport: Transport, installed: Record<string, boolean>, account: string | null | undefined): Promise<void> {
  return account && installed[account] ? transport.openWebApp(account) : transport.openUrl('https://claude.ai/code');
}
