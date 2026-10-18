import { useCallback, useEffect, useState } from 'react';
import type { PluginListData, PluginWidgetsData } from '@devhost/contract/lite';
import { useApp } from './app-context';

export type PluginInfo = PluginListData['plugins'][number];
export type PluginActionInfo = PluginInfo['actions'][number] & { plugin: string };
export type PluginWidget = PluginWidgetsData['widgets'][number];

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
  /** One plugin's action by id (for a widget's or a doctor advice's button). */
  const action = (plugin: string, id: string): PluginActionInfo | undefined => {
    const a = plugins.find((p) => p.name === plugin && p.enabled && !p.error)?.actions.find((x) => x.id === id);
    return a ? { ...a, plugin } : undefined;
  };
  return { plugins, loaded, actions, action, refresh };
}

/**
 * Plugins' dashboard cards: loaded on connect, then every `everyMs` (they may measure slow things,
 * like disk usage, so not with every dashboard snapshot). The last cards stay while a reload runs.
 */
export function usePluginWidgets(everyMs = 300_000) {
  const { client, connection } = useApp();
  const [widgets, setWidgets] = useState<PluginWidget[]>([]);
  const refresh = useCallback(async () => {
    try {
      setWidgets((await client.pluginWidgets()).widgets);
    } catch {
      /* keep the last cards; an older CLI has no `plugin widgets` */
    }
  }, [client]);
  useEffect(() => {
    if (connection.kind !== 'connected') return;
    void refresh();
    const t = setInterval(() => void refresh(), everyMs);
    return () => clearInterval(t);
  }, [connection.kind, refresh, everyMs]);
  return { widgets, refresh };
}
