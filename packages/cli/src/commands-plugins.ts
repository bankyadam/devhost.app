import type { PluginListData, PluginRunData } from '@devhost/contract';
import { long, newExecutor, short, type GlobalOptions } from './command-support.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';
import { makePrompter } from './prompter.js';
import type { ActionTarget } from './plugins/api.js';
import { findEnvironment, findSession, pluginContext } from './plugins/context.js';
import { loadPlugins } from './plugins/loader.js';

export function pluginListCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<PluginListData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const plugins = (await loadPlugins(config, deps.home)).map((p) => ({
      name: p.name,
      ...(p.plugin ? { version: p.plugin.version, description: p.plugin.description } : {}),
      builtin: p.builtin,
      enabled: p.enabled,
      source: p.source,
      ...(p.error ? { error: p.error } : {}),
      actions: (p.plugin?.actions ?? []).map((a) => ({ id: a.id, title: a.title, description: a.description, scope: a.scope, destructive: a.destructive === true })),
      checks: (p.plugin?.checks ?? []).map((c) => c.id),
    }));
    const human = plugins.length === 0
      ? 'No plugins.'
      : plugins
          .map((p) => [
            `${p.enabled ? '●' : '○'} ${p.name}${p.version ? ` ${p.version}` : ''}${p.builtin ? ' (built-in)' : ''}${p.description ? ` — ${p.description}` : ''}${p.error ? `\n    ❌ ${p.error}` : ''}`,
            ...p.actions.map((a) => `    ${a.id} [${a.scope}${a.destructive ? ', asks first' : ''}] ${a.description}`),
          ].join('\n'))
          .join('\n');
    return { data: { plugins }, human };
  });
}

export interface PluginRunOptions {
  plugin: string;
  action: string;
  env?: string;
  session?: string;
  dryRun: boolean;
}

/** `devhost plugin run <plugin> <action>`: progress and prompts as for apply, then the action's result. */
export function pluginRunCommand(deps: Deps, g: GlobalOptions, o: PluginRunOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const loaded = (await loadPlugins(config, deps.home)).find((p) => p.name === o.plugin);
    if (!loaded) throw new UsageError(`no plugin named "${o.plugin}"`, 'See `devhost plugin list`.');
    if (!loaded.enabled) throw new UsageError(`plugin "${o.plugin}" is disabled`, `Set plugins.${o.plugin}.enabled: true in config.yaml.`);
    if (!loaded.plugin) throw new DevhostError(`plugin "${o.plugin}" could not be loaded: ${loaded.error ?? 'unknown error'}`, 'plugin-load-failed');
    const action = loaded.plugin.actions?.find((a) => a.id === o.action);
    if (!action) throw new UsageError(`plugin "${o.plugin}" has no action "${o.action}"`, `Its actions: ${(loaded.plugin.actions ?? []).map((a) => a.id).join(', ') || 'none'}.`);

    const exec = newExecutor(deps, g, reporter, o.dryRun);
    const prompter = makePrompter(deps, g.json, g.yes);
    const ctx = pluginContext({ config, name: o.plugin, home: deps.home, user: deps.user, exec, reporter, prompter });
    const target: ActionTarget = {};
    if (action.scope === 'environment') {
      if (!o.env) throw new UsageError(`${o.plugin} ${o.action} needs --env <name>`);
      target.environment = findEnvironment(ctx, o.env);
    } else if (action.scope === 'session') {
      if (!o.session) throw new UsageError(`${o.plugin} ${o.action} needs --session <id>`);
      target.session = findSession(deps.home, o.session);
    } else if (o.env || o.session) {
      throw new UsageError(`${o.plugin} ${o.action} works on the whole host; it takes no --env or --session`);
    }
    const what = target.environment ? ` for ${target.environment.name}` : target.session ? ` for session ${target.session.id.slice(0, 8)}` : '';
    const step = `plugin.${o.plugin}.${o.action}`;
    exec.beginStep(step);
    if (action.destructive && !o.dryRun && !(await prompter.confirm(`${o.plugin}-${o.action}`, `${action.title}${what}?`))) {
      return { ok: false, data: null, error: new DevhostError('not confirmed; nothing was changed', 'not-confirmed') };
    }
    reporter.step(step, 'start', `${action.title}${what}`);
    try {
      const result = await action.run(ctx, target);
      reporter.step(step, o.dryRun ? 'ok' : 'changed', result.summary);
      const data: PluginRunData = { plugin: o.plugin, action: o.action, dryRun: o.dryRun, summary: result.summary, ...(result.data ? { data: result.data } : {}), ...(o.dryRun ? { plan: exec.plan } : {}) };
      const plan = o.dryRun && exec.plan.length > 0 ? ['', 'Dry run plan (nothing was changed):', ...exec.plan.map((p) => `  ${p.sudo ? '[sudo] ' : ''}${p.action}${p.reason ? `  — ${p.reason}` : ''}`)] : [];
      return { ok: true, data, human: [result.summary, ...plan] };
    } catch (err) {
      reporter.step(step, 'failed', err instanceof Error ? err.message : String(err));
      return { ok: false, data: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  });
}
