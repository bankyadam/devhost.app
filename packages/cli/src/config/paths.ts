import { join, isAbsolute, resolve } from 'node:path';

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export function devhostConfigDir(home: string): string {
  return join(home, '.config', 'devhost');
}

export function defaultConfigPath(home: string): string {
  return join(devhostConfigDir(home), 'config.yaml');
}

export function resolveConfigPath(flag: string | undefined, home: string, cwd: string): string {
  if (!flag) return defaultConfigPath(home);
  const expanded = expandHome(flag, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
