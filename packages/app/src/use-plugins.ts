import { useCallback, useEffect, useState } from 'react';
import type { PluginListData, PluginWidgetsData } from '@devhost/contract/lite';
import { useApp } from './app-context';

export type PluginInfo = PluginListData['plugins'][number];
export type PluginActionInfo = PluginInfo['actions'][number] & { plugin: string };
export type PluginWidget = PluginWidgetsData['widgets'][number];
export type PluginFilter = PluginWidgetsData['filters'][number];

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
 * Plugins' dashboard controls and cards, computed with `params` (`<plugin>.<filter>` → value):
 * loaded on connect and when a filter changes, then as often as the most eager card asks
 * (`refreshSeconds`, default 5 minutes). The last cards stay while a reload runs.
 */
export function usePluginWidgets(params: Record<string, string> = {}) {
  const { client, connection } = useApp();
  const [data, setData] = useState<PluginWidgetsData>({ filters: [], widgets: [] });
  const key = JSON.stringify(params);
  const refresh = useCallback(async () => {
    try {
      const d = await client.pluginWidgets(JSON.parse(key) as Record<string, string>);
      setData({ filters: d.filters ?? [], widgets: d.widgets });
    } catch {
      /* keep the last cards; an older CLI has no `plugin widgets` */
    }
  }, [client, key]);
  const everyMs = Math.min(300, ...data.widgets.map((w) => w.refreshSeconds ?? 300)) * 1000;
  useEffect(() => {
    if (connection.kind !== 'connected') return;
    void refresh();
    const t = setInterval(() => void refresh(), everyMs);
    return () => clearInterval(t);
  }, [connection.kind, refresh, everyMs]);
  return { widgets: data.widgets, filters: data.filters, refresh };
}
