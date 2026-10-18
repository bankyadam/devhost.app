import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DevhostConfig } from '@devhost/contract';
import { devhostConfigDir } from '../config/paths.js';
import type { DevhostPlugin } from './api.js';
import { builtinPlugins } from './builtin/index.js';
import { SOURCE_FILE } from './install.js';

export interface LoadedPlugin {
  name: string;
  builtin: boolean;
  enabled: boolean;
  source: string;
  plugin?: DevhostPlugin;
  /** Why it could not be loaded. */
  error?: string;
  /** From `devhost plugin install`. */
  installedFrom?: { url: string; ref?: string; commit?: string; installedAt?: string };
}

async function readSource(dir: string): Promise<LoadedPlugin['installedFrom']> {
  try {
    const d = JSON.parse(await readFile(join(dir, SOURCE_FILE), 'utf8')) as { url?: unknown; ref?: unknown; commit?: unknown; installedAt?: unknown };
    if (typeof d.url !== 'string') return undefined;
    return { url: d.url, ...(typeof d.ref === 'string' ? { ref: d.ref } : {}), ...(typeof d.commit === 'string' ? { commit: d.commit } : {}), ...(typeof d.installedAt === 'string' ? { installedAt: d.installedAt } : {}) };
  } catch {
    return undefined;
  }
}

export const userPluginsDir = (home: string): string => join(devhostConfigDir(home), 'plugins');
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

function valid(p: unknown): p is DevhostPlugin {
  const x = p as DevhostPlugin | null;
  return !!x && typeof x.name === 'string' && typeof x.version === 'string' && typeof x.description === 'string' && (x.actions === undefined || Array.isArray(x.actions)) && (x.checks === undefined || Array.isArray(x.checks)) && (x.advice === undefined || Array.isArray(x.advice)) && (x.widgets === undefined || Array.isArray(x.widgets));
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
    // Dot directories are installs in progress.
    dirs = (await readdir(userPluginsDir(home), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
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
    const installedFrom = await readSource(join(userPluginsDir(home), name));
    const base = { name, builtin: false, enabled, source, ...(installedFrom ? { installedFrom } : {}) };
    if (!enabled) {
      out.push(base);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(source).href)) as { default?: unknown };
      if (!valid(mod.default)) throw new Error('its default export is not a devhost plugin (name, version, description, actions, checks)');
      if (mod.default.name !== name) throw new Error(`it calls itself ${mod.default.name}, its directory is ${name}`);
      out.push({ ...base, plugin: mod.default });
    } catch (err) {
      out.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
