import { join } from 'node:path';
import { UsageError } from '../errors.js';

/** Where an installed plugin came from, next to its code. */
export const SOURCE_FILE = '.devhost-source.json';

export interface PluginSource {
  /** What was asked for: a GitHub URL or owner/repo. */
  spec: string;
  /** What git clones. */
  url: string;
  ref?: string;
  /** The directory (and plugin) name it gets. */
  name: string;
}

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const PART = /^[A-Za-z0-9_.-]+$/;

const nameFromRepo = (repo: string): string => repo.replace(/\.git$/, '').toLowerCase().replace(/^devhost-plugin-/, '').replace(/^devhost-/, '').replace(/[^a-z0-9-]/g, '-');

/**
 * A plugin source: `owner/repo`, `https://github.com/owner/repo[.git][/tree/<ref>]`,
 * `git@github.com:owner/repo.git`, or any other https/ssh git URL; `#<ref>` picks a branch or tag.
 * The name is `--name`, else the repository's without a `devhost-plugin-` prefix.
 */
export function parsePluginSource(spec: string, name?: string): PluginSource {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith('-') || /\s/.test(trimmed)) throw new UsageError(`"${spec}" is not a plugin source`, 'Give a GitHub URL or owner/repo.');
  const [base, hashRef] = trimmed.split('#', 2) as [string, string | undefined];
  let url: string;
  let repo: string;
  let ref = hashRef;
  let m: RegExpExecArray | null;
  if ((m = /^([^/:@]+)\/([^/:@]+)$/.exec(base)) && PART.test(m[1]!) && PART.test(m[2]!)) {
    url = `https://github.com/${m[1]}/${m[2]!.replace(/\.git$/, '')}.git`;
    repo = m[2]!;
  } else if ((m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?\/?$/.exec(base)) && PART.test(m[1]!) && PART.test(m[2]!)) {
    url = `https://github.com/${m[1]}/${m[2]}.git`;
    repo = m[2]!;
    ref ??= m[3];
  } else if ((m = /^(?:https:\/\/|ssh:\/\/|git@)[^\s]+?[/:]([^/:]+?)(?:\.git)?\/?$/.exec(base))) {
    url = base;
    repo = m[1]!;
  } else {
    throw new UsageError(`"${spec}" is not a plugin source`, 'Give a GitHub URL (https://github.com/owner/repo), owner/repo, or a git URL.');
  }
  if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) throw new UsageError(`"${ref}" is not a branch or tag name`);
  const finalName = name ?? nameFromRepo(repo);
  if (!PLUGIN_NAME.test(finalName)) throw new UsageError(`"${finalName}" is not a plugin name`, 'Lowercase letters, digits and dashes, starting with a letter; use --name.');
  return { spec: trimmed, url, ...(ref ? { ref } : {}), name: finalName };
}

export const pluginDir = (pluginsDir: string, name: string): string => join(pluginsDir, name);
