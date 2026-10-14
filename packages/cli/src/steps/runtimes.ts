import { installMise, miseBinary } from '../mise.js';
import { ok, skip, todo, type Step, type StepContext } from './types.js';

function wanted(ctx: StepContext): [string, string][] {
  return Object.entries(ctx.config.runtimes ?? {});
}

interface MiseEntry {
  requested_version?: string;
  installed?: boolean;
}

/** Tools from `mise ls --json` whose requested version is installed. */
export function installedRequests(json: string): Map<string, Set<string>> | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const result = new Map<string, Set<string>>();
  for (const [tool, entries] of Object.entries(data as Record<string, unknown>)) {
    const set = new Set<string>();
    if (Array.isArray(entries)) {
      for (const e of entries as MiseEntry[]) {
        if (e.installed && typeof e.requested_version === 'string') set.add(e.requested_version);
      }
    }
    result.set(tool, set);
  }
  return result;
}

export const runtimesStep: Step = {
  id: 'runtimes',
  description: 'Install mise (its installer) and the language runtimes',
  async check(ctx) {
    const want = wanted(ctx);
    if (want.length === 0) return skip('no runtimes configured');
    const mise = await miseBinary(ctx.exec, ctx.home);
    if (!mise) return todo('mise is not installed yet');
    const r = await ctx.exec.query(mise, ['ls', '--global', '--json']);
    if (r.code === 127) return todo('mise is not installed yet');
    if (r.code !== 0) return todo(`mise ls failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    const have = installedRequests(r.stdout);
    if (!have) return todo('could not parse `mise ls --json`');
    const missing = want.filter(([tool, version]) => !have.get(tool)?.has(version)).map(([t, v]) => `${t}@${v}`);
    return missing.length === 0 ? ok() : todo(`missing: ${missing.join(', ')}`);
  },
  async apply(ctx) {
    const specs = wanted(ctx).map(([tool, version]) => `${tool}@${version}`);
    const mise = (await miseBinary(ctx.exec, ctx.home)) ?? (await installMise(ctx.exec, ctx.home));
    await ctx.exec.exec(mise, ['use', '--global', '--yes', ...specs], { progress: true });
  },
};
