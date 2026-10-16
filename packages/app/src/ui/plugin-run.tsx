import type { PluginRunData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { pluginRunArgs, type PluginTarget } from '../client/client';
import type { PluginActionInfo } from '../use-plugins';
import { RunDialog } from './run-dialog';

/** One plugin action, live: its log, its confirmation prompt (from the CLI) and its summary. */
export function PluginRunDialog({ action, target, dryRun = false, onClose }: { action: PluginActionInfo; target: PluginTarget; dryRun?: boolean; onClose: () => void }) {
  const { client } = useApp();
  const what = target.env ? ` · ${target.env}` : target.session ? ` · ${target.session.slice(0, 8)}` : '';
  return (
    <RunDialog<PluginRunData>
      title={`${dryRun ? 'Preview: ' : ''}${action.title}${what}`}
      begin={(h) => client.pluginRun(action.plugin, action.id, target, dryRun, h)}
      terminal={{ kind: 'devhost', args: pluginRunArgs(action.plugin, action.id, target, dryRun) }}
      onClose={onClose}
      after={(r) => (r.data ? <pre className="logview" aria-label="Result">{r.data.summary}</pre> : null)}
    >
      <p className="sec">{action.description}</p>
    </RunDialog>
  );
}
