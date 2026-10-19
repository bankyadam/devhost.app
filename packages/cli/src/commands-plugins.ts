import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginChangeData, PluginListData, PluginRunData, PluginWidgetsData } from '@devhost/contract';
import { long, newExecutor, newReporter, short, type GlobalOptions } from './command-support.js';
import { editConfigFile } from './config/edit.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';
import { makePrompter, NoPrompter } from './prompter.js';
import type { ActionTarget, WidgetContent } from './plugins/api.js';
import { findEnvironment, findSession, pluginContext } from './plugins/context.js';
import { builtinPlugins } from './plugins/builtin/index.js';
import { parsePluginSource, PLUGIN_NAME, pluginDir, SOURCE_FILE } from './plugins/install.js';
import { loadPlugins, userPluginsDir } from './plugins/loader.js';

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
      ...(p.installedFrom ? { installedFrom: p.installedFrom } : {}),
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

type Widget = PluginWidgetsData['widgets'][number];
type Filter = PluginWidgetsData['filters'][number];

/** The card as the contract has it: only what is set, text as text. */
function widgetOut(base: Pick<Widget, 'plugin' | 'id' | 'title'> & Partial<Widget>, c: WidgetContent): Widget {
  return {
    ...base,
    ...(c.status ? { status: c.status } : {}),
    ...(c.summary ? { summary: c.summary } : {}),
    ...(c.account ? { account: c.account } : {}),
    ...(c.tiles?.length ? { tiles: c.tiles.map((t) => ({ label: String(t.label), value: String(t.value), ...(t.sub ? { sub: String(t.sub) } : {}) })) } : {}),
    ...(c.rows?.length ? { rows: c.rows.map((r) => ({ label: String(r.label), value: String(r.value), ...(r.note ? { note: String(r.note) } : {}) })) } : {}),
    ...(c.meter ? { meter: { label: String(c.meter.label), value: Number(c.meter.value), max: Number(c.meter.max) } } : {}),
    ...(c.chart ? { chart: c.chart } : {}),
    ...(c.note ? { note: c.note } : {}),
    ...(c.action ? { action: c.action } : {}),
  };
}

/**
 * `devhost plugin widgets [--param <plugin>.<filter>=<value>]…`: every enabled plugin's dashboard
 * controls and cards, computed with the given filter values (else their defaults). Read-only; a
 * widget that throws says so on its card.
 */
export function pluginWidgetsCommand(deps: Deps, g: GlobalOptions, rawParams: string[] = []): Promise<number> {
  return short<PluginWidgetsData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const given = new Map<string, string>();
    for (const p of rawParams) {
      const m = /^([a-z][a-z0-9-]*)\.([A-Za-z0-9_-]+)=(.*)$/s.exec(p);
      if (!m) throw new UsageError(`--param takes <plugin>.<filter>=<value>, not "${p}"`);
      given.set(`${m[1]}.${m[2]}`, m[3]!);
    }
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const silent = { step: () => undefined, log: () => undefined };
    const widgets: Widget[] = [];
    const filters: Filter[] = [];
    for (const p of await loadPlugins(config, deps.home)) {
      if (!p.enabled || !p.plugin?.widgets?.length) continue;
      const ctx = pluginContext({ config, name: p.name, home: deps.home, user: deps.user, nodePath: deps.nodePath, exec, reporter: silent, prompter: new NoPrompter(), now: () => deps.now().getTime() });
      const params: Record<string, string> = {};
      for (const f of p.plugin.filters ?? []) {
        let options: { value: string; label: string }[] = [];
        try {
          options = (await f.options(ctx)).map((o) => ({ value: String(o.value), label: String(o.label) }));
        } catch {
          /* no choices this time */
        }
        const want = given.get(`${p.name}.${f.id}`) ?? f.default ?? '';
        // An unknown value (an account since removed) falls back to the default.
        const value = want === '' && f.kind === 'select' ? '' : options.some((o) => o.value === want) ? want : (f.default ?? (f.kind === 'select' ? '' : (options[0]?.value ?? '')));
        params[f.id] = value;
        filters.push({ plugin: p.name, id: f.id, label: f.label, kind: f.kind, options, value, ...(f.allLabel ? { allLabel: f.allLabel } : {}) });
      }
      for (const w of p.plugin.widgets) {
        const base = { plugin: p.name, id: w.id, title: w.title, ...(w.size ? { size: w.size } : {}), ...(w.refreshSeconds ? { refreshSeconds: w.refreshSeconds } : {}) };
        try {
          const c = await w.run(ctx, { ...params });
          if (Array.isArray(c)) for (const card of c) widgets.push(widgetOut({ ...base, id: `${w.id}:${card.key}`, title: card.title }, card));
          else widgets.push(widgetOut(base, c));
        } catch (err) {
          widgets.push({ ...base, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    const human = widgets.length === 0
      ? 'No plugin widgets.'
      : [
          ...filters.map((f) => `${f.plugin} ${f.label}: ${f.options.find((o) => o.value === f.value)?.label ?? (f.allLabel ?? 'all')}`),
          ...widgets.map((w) => [
            `${w.title} (${w.plugin})${w.status ? ` [${w.status}]` : ''}${w.summary ? ` — ${w.summary}` : ''}${w.error ? `\n    ❌ ${w.error}` : ''}`,
            ...(w.tiles ?? []).map((t) => `    ${t.label}: ${t.value}${t.sub ? ` (${t.sub})` : ''}`),
            ...(w.rows ?? []).map((r) => `    ${r.label}: ${r.value}${r.note ? ` — ${r.note}` : ''}`),
            ...(w.meter ? [`    ${w.meter.label}: ${Math.round((w.meter.value / (w.meter.max || 1)) * 100)}%`] : []),
            ...(w.chart ? [`    ${w.chart.title}: ${w.chart.points.length} columns`] : []),
            ...(w.action ? [`    → devhost plugin run ${w.plugin} ${w.action}`] : []),
          ].join('\n')),
        ].join('\n');
    return { data: { filters, widgets }, human };
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
    const ctx = pluginContext({ config, name: o.plugin, home: deps.home, user: deps.user, nodePath: deps.nodePath, exec, reporter, prompter });
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
      // The summary follows in full; the step line only says it is done (changed only when it may have).
      reporter.step(step, action.destructive && !o.dryRun ? 'changed' : 'ok');
      const data: PluginRunData = { plugin: o.plugin, action: o.action, dryRun: o.dryRun, summary: result.summary, ...(result.data ? { data: result.data } : {}), ...(o.dryRun ? { plan: exec.plan } : {}) };
      const plan = o.dryRun && exec.plan.length > 0 ? ['', 'Dry run plan (nothing was changed):', ...exec.plan.map((p) => `  ${p.sudo ? '[sudo] ' : ''}${p.action}${p.reason ? `  — ${p.reason}` : ''}`)] : [];
      return { ok: true, data, human: [result.summary, ...plan] };
    } catch (err) {
      reporter.step(step, 'failed', err instanceof Error ? err.message : String(err));
      return { ok: false, data: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  });
}

export interface PluginInstallOptions {
  source: string;
  name?: string;
  enable: boolean;
  dryRun: boolean;
}

/**
 * `devhost plugin install <github URL | owner/repo[#ref]>`: a shallow clone into
 * ~/.config/devhost/plugins/<name>, its npm dependencies without install scripts, and where it
 * came from. Nothing of it runs until it is enabled (`--enable`, or `plugin enable` later).
 */
export function pluginInstallCommand(deps: Deps, g: GlobalOptions, o: PluginInstallOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    await loadConfig(g.configPath); // a configured host
    const src = parsePluginSource(o.source, o.name);
    if (builtinPlugins.some((p) => p.name === src.name)) throw new UsageError(`"${src.name}" is a built-in plugin`, 'Install it under another name with --name.');
    const dir = pluginDir(userPluginsDir(deps.home), src.name);
    if (existsSync(dir)) throw new UsageError(`plugin "${src.name}" is installed already`, `Remove it first: devhost plugin uninstall ${src.name}`);
    const exec = newExecutor(deps, g, reporter, o.dryRun);
    const step = `plugin.install.${src.name}`;
    exec.beginStep(step);
    reporter.step(step, 'start', `install ${src.name} from ${src.url}${src.ref ? `#${src.ref}` : ''}`);
    const tmp = join(userPluginsDir(deps.home), `.installing-${src.name}`);
    await exec.mkdirp(userPluginsDir(deps.home));
    await exec.remove(tmp, { recursive: true });
    try {
      await exec.exec('git', ['clone', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), '--', src.url, tmp], { progress: true });
      let commit = '';
      if (!exec.dryRun) {
        if (!existsSync(join(tmp, 'index.js'))) throw new DevhostError(`${src.url} has no index.js at its root`, 'plugin-invalid', 1, 'A devhost plugin is an ES module index.js whose default export is the plugin.');
        if (hasDependencies(join(tmp, 'package.json'))) {
          // Its dependencies, without running any of their install scripts. npm starts with
          // `#!/usr/bin/env node`: over ssh (the app) PATH has no nvm Node, so put devhost's first.
          await exec.exec(npmBin(deps.nodePath), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tmp, progress: true, env: { PATH: `${dirname(deps.nodePath)}:${deps.env['PATH'] ?? '/usr/bin:/bin'}` } });
        }
        commit = (await exec.query('git', ['-C', tmp, 'rev-parse', 'HEAD'])).stdout.trim();
      }
      await exec.writeText(join(tmp, SOURCE_FILE), `${JSON.stringify({ url: src.url, ...(src.ref ? { ref: src.ref } : {}), commit, installedAt: deps.now().toISOString() }, null, 2)}\n`);
      await exec.exec('mv', [tmp, dir]);
      if (o.enable && !exec.dryRun) await setEnabled(deps, g, src.name, true);
      reporter.step(step, 'changed', commit ? `at ${commit.slice(0, 12)}` : undefined);
      const data: PluginChangeData = { name: src.name, action: 'installed', enabled: o.enable, url: src.url, ...(src.ref ? { ref: src.ref } : {}), ...(commit ? { commit } : {}), ...(o.dryRun ? { dryRun: true } : {}) };
      return { ok: true, data, human: [o.enable ? `Installed and enabled ${src.name}.` : `Installed ${src.name}. It runs nothing until you enable it: devhost plugin enable ${src.name}`] };
    } catch (err) {
      if (!exec.dryRun) await exec.remove(tmp, { recursive: true });
      reporter.step(step, 'failed', err instanceof Error ? err.message : String(err));
      return { ok: false, data: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  });
}

function hasDependencies(packageJson: string): boolean {
  try {
    const p = JSON.parse(readFileSync(packageJson, 'utf8')) as { dependencies?: Record<string, unknown> };
    return Object.keys(p.dependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}

const npmBin = (nodePath: string): string => (existsSync(join(dirname(nodePath), 'npm')) ? join(dirname(nodePath), 'npm') : 'npm');

/** `plugins.<name>.enabled` in config.yaml (comments kept, validated, backed up). */
async function setEnabled(deps: Deps, g: GlobalOptions, name: string, enabled: boolean): Promise<void> {
  await editConfigFile(g.configPath, deps.now(), (doc) => doc.setIn(['plugins', name, 'enabled'], enabled));
}

/** `devhost plugin uninstall <name>`: its directory and its config entry. Built-in ones can only be disabled. */
export function pluginUninstallCommand(deps: Deps, g: GlobalOptions, name: string): Promise<number> {
  return short<PluginChangeData>(deps, g, async () => {
    if (builtinPlugins.some((p) => p.name === name)) throw new UsageError(`"${name}" is built in and cannot be uninstalled`, `Turn it off instead: devhost plugin disable ${name}`);
    if (!PLUGIN_NAME.test(name)) throw new UsageError(`"${name}" is not a plugin name`);
    const dir = pluginDir(userPluginsDir(deps.home), name);
    if (!existsSync(dir)) throw new UsageError(`no plugin "${name}" is installed in ${userPluginsDir(deps.home)}`);
    await rm(dir, { recursive: true, force: true });
    const { config } = await loadConfig(g.configPath);
    if (config.plugins?.[name] !== undefined) await editConfigFile(g.configPath, deps.now(), (doc) => doc.deleteIn(['plugins', name]));
    return { data: { name, action: 'uninstalled', enabled: false }, human: `Removed ${name} (${dir}) and its config entry.` };
  });
}

/** `devhost plugin enable|disable <name>`. */
export function pluginToggleCommand(deps: Deps, g: GlobalOptions, name: string, enabled: boolean): Promise<number> {
  return short<PluginChangeData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    if (!(await loadPlugins(config, deps.home)).some((p) => p.name === name)) throw new UsageError(`no plugin named "${name}"`, 'See `devhost plugin list`.');
    await setEnabled(deps, g, name, enabled);
    return { data: { name, action: enabled ? 'enabled' : 'disabled', enabled }, human: `${name} is ${enabled ? 'on' : 'off'}.` };
  });
}
