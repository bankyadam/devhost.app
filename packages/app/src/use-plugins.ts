import { useCallback, useEffect, useState } from 'react';
import type { PluginListData } from '@devhost/contract/lite';
import { useApp } from './app-context';

export type PluginInfo = PluginListData['plugins'][number];
export type PluginActionInfo = PluginInfo['actions'][number] & { plugin: string };

/** The host's plugins and their actions by scope, for the screens' menus. Loaded once per connection. */
export function usePlugins() {
  const { client, connection } = useApp();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setPlugins((await client.plugins()).plugins);
    } catch {
      setPlugins([]);
    } finally {
      setLoaded(true);
    }
  }, [client]);
  useEffect(() => {
    if (connection.kind === 'connected') void refresh();
  }, [connection.kind, refresh]);
  const actions = (scope: PluginActionInfo['scope']): PluginActionInfo[] =>
    plugins.filter((p) => p.enabled && !p.error).flatMap((p) => p.actions.filter((a) => a.scope === scope).map((a) => ({ ...a, plugin: p.name })));
  return { plugins, loaded, actions, refresh };
}
