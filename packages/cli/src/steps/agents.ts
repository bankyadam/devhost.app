import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { accountsOf, effectiveClaudeDir, envDir, environmentsOf } from '../config/accounts.js';
import { agentCatalog } from '../agents/catalog.js';
import { agentFile, MANAGED_MARK } from '../agents/files.js';
import type { StepContext } from './types.js';
import { ok, todo, type Step } from './types.js';

/** Where agent files go and which agents belong there: per account (its Claude config dir) and per environment (its `.claude/agents`). */
export function agentTargets(config: DevhostConfig, home: string): { dir: string; names: string[] }[] {
  const accounts = accountsOf(config);
  return [
    ...accounts.map((a) => ({ dir: join(effectiveClaudeDir(a, home), 'agents'), names: a.agents ?? [] })),
    ...environmentsOf(config).flatMap((e) => {
      const a = accounts.find((x) => x.name === e.account);
      return a ? [{ dir: join(envDir(a, e, home), '.claude', 'agents'), names: e.agents ?? [] }] : [];
    }),
  ];
}

interface Plan {
  write: { path: string; content: string }[];
  remove: string[];
}

async function plan(ctx: StepContext): Promise<Plan> {
  const catalog = agentCatalog((ctx.config.agents?.custom ?? []) as never);
  const out: Plan = { write: [], remove: [] };
  for (const t of agentTargets(ctx.config, ctx.home)) {
    const wanted = new Set<string>();
    for (const n of t.names) {
      const def = catalog.get(n);
      if (!def) continue; // an unknown name is reported by the config's semantic check
      wanted.add(`${n}.md`);
      const path = join(t.dir, `${n}.md`);
      const content = agentFile(def);
      const current = await ctx.exec.readText(path);
      if (current === content) continue;
      // A file of the same name that devhost did not write is the user's: left alone.
      if (current !== null && !current.includes(MANAGED_MARK)) continue;
      out.write.push({ path, content });
    }
    for (const f of await readdir(t.dir).catch(() => [] as string[])) {
      if (!f.endsWith('.md') || wanted.has(f)) continue;
      if ((await ctx.exec.readText(join(t.dir, f)))?.includes(MANAGED_MARK)) out.remove.push(join(t.dir, f));
    }
  }
  return out;
}

export const agentsStep: Step = {
  id: 'agents',
  description: 'Write the configured subagent definitions for accounts and environments',
  async check(ctx) {
    const p = await plan(ctx);
    return p.write.length + p.remove.length === 0 ? ok() : todo(`${p.write.length} agent file(s) to write, ${p.remove.length} to remove`);
  },
  async apply(ctx) {
    const p = await plan(ctx);
    for (const w of p.write) await ctx.exec.writeText(w.path, w.content, { description: `write agent ${w.path}`, dirMode: 0o755 });
    for (const r of p.remove) await ctx.exec.remove(r);
  },
};
