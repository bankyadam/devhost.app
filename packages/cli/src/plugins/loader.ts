import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DevhostConfig } from '@devhost/contract';
import { devhostConfigDir } from '../config/paths.js';
import type { DevhostPlugin } from './api.js';
import { builtinPlugins } from './builtin/index.js';

export interface LoadedPlugin {
  name: string;
  builtin: boolean;
  enabled: boolean;
  source: string;
  plugin?: DevhostPlugin;
  /** Why it could not be loaded. */
  error?: string;
}

export const userPluginsDir = (home: string): string => join(devhostConfigDir(home), 'plugins');
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

function valid(p: unknown): p is DevhostPlugin {
  const x = p as DevhostPlugin | null;
  return !!x && typeof x.name === 'string' && typeof x.version === 'string' && typeof x.description === 'string' && (x.actions === undefined || Array.isArray(x.actions)) && (x.checks === undefined || Array.isArray(x.checks));
}

/**
 * Built-in plugins are on unless `plugins.<name>.enabled: false`; one in
 * ~/.config/devhost/plugins/<name>/index.js only with `enabled: true`, since it is code you added.
 */
export async function loadPlugins(config: DevhostConfig, home: string): Promise<LoadedPlugin[]> {
  const settings = config.plugins ?? {};
  const out: LoadedPlugin[] = builtinPlugins.map((p) => ({ name: p.name, builtin: true, enabled: settings[p.name]?.enabled !== false, source: 'built-in', plugin: p }));
  let dirs: string[] = [];
  try {
    dirs = (await readdir(userPluginsDir(home), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    /* no user plugins */
  }
  for (const name of dirs) {
    const source = join(userPluginsDir(home), name, 'index.js');
    if (!NAME.test(name)) {
      out.push({ name, builtin: false, enabled: false, source, error: 'plugin names are lowercase letters, digits and dashes' });
      continue;
    }
    if (out.some((p) => p.name === name)) {
      out.push({ name, builtin: false, enabled: false, source, error: `a built-in plugin is already called ${name}` });
      continue;
    }
    const enabled = settings[name]?.enabled === true;
    if (!enabled) {
      out.push({ name, builtin: false, enabled, source });
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(source).href)) as { default?: unknown };
      if (!valid(mod.default)) throw new Error('its default export is not a devhost plugin (name, version, description, actions, checks)');
      if (mod.default.name !== name) throw new Error(`it calls itself ${mod.default.name}, its directory is ${name}`);
      out.push({ name, builtin: false, enabled, source, plugin: mod.default });
    } catch (err) {
      out.push({ name, builtin: false, enabled, source, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
