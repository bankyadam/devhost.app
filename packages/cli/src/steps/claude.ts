import { join } from 'node:path';
import { HumanActionRequired } from '../errors.js';
import { accountsOf, effectiveClaudeDir, type Account } from '../config/accounts.js';
import { managedSettings, mergeSettings, parseSettings, stringifySettings } from '../claude-settings.js';
import { renderTemplate } from '../render.js';
import { readState, whichBinary, writeState } from '../state.js';
import { markdownBlock } from './shellblock.js';
import { ok, skip, todo, type Step, type StepContext } from './types.js';

/** Install Claude Code and record its absolute path for plists (spec A7.5). */
export const claudeBinaryStep: Step = {
  id: 'claude.binary',
  description: 'Install Claude Code and record its absolute path',
  async check({ home, exec }) {
    const path = await whichBinary(exec, 'claude');
    if (!path) return todo('Claude Code is not installed');
    const state = await readState(exec, home);
    const node = await whichBinary(exec, 'node');
    if (state.claudePath !== path || (node && state.nodePath !== node)) return todo('recorded tool paths are out of date');
    return ok();
  },
  async apply({ config, home, exec }) {
    let path = await whichBinary(exec, 'claude');
    if (!path) {
      if (config.claude?.install === 'native') {
        await exec.exec('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], { reason: 'install Claude Code with the native installer' });
        path = await whichBinary(exec, 'claude');
      } else if (!exec.dryRun) {
        throw new HumanActionRequired(
          'Claude Code is not on PATH even though the Brewfile installs it.',
          'Run `brew install --cask claude-code`, then `devhost apply` again.',
        );
      }
    }
    const state = await readState(exec, home);
    const node = await whichBinary(exec, 'node');
    await writeState(exec, home, { ...state, ...(path ? { claudePath: path } : {}), ...(node ? { nodePath: node } : {}) });
  },
};

export const settingsPathOf = (a: Account, home: string): string => join(effectiveClaudeDir(a, home), 'settings.json');
export const claudeMdPathOf = (a: Account, home: string): string => join(effectiveClaudeDir(a, home), 'CLAUDE.md');

function scoped(ctx: StepContext): Account[] {
  return accountsOf(ctx.config).filter((a) => !ctx.onlyAccount || a.name === ctx.onlyAccount);
}

async function wantedSettings(ctx: StepContext, a: Account): Promise<string> {
  const text = await ctx.exec.readText(settingsPathOf(a, ctx.home));
  const port = ctx.config.collector?.port ?? 4318;
  const merged = mergeSettings(parseSettings(text, settingsPathOf(a, ctx.home)), managedSettings(ctx.config, a), port);
  return stringifySettings(merged);
}

async function wantedClaudeMd(ctx: StepContext, a: Account): Promise<string> {
  const file = claudeMdPathOf(a, ctx.home);
  const body = (await renderTemplate('CLAUDE.md', {})).trimEnd().split('\n');
  return markdownBlock.upsert((await ctx.exec.readText(file)) ?? '', body, file);
}

/** Per account: config dir, settings.json merge (A7.5, A10.2) and the shared CLAUDE.md (A8). */
export const accountsClaudeStep: Step = {
  id: 'accounts.claude',
  description: 'Merge devhost settings and CLAUDE.md into each account\'s Claude config',
  async check(ctx) {
    const accounts = scoped(ctx);
    if (accounts.length === 0) return skip('no accounts configured');
    const stale: string[] = [];
    for (const a of accounts) {
      const settings = await ctx.exec.readText(settingsPathOf(a, ctx.home));
      if ((await wantedSettings(ctx, a)) !== settings) stale.push(`${a.name}: settings.json`);
      if ((await wantedClaudeMd(ctx, a)) !== (await ctx.exec.readText(claudeMdPathOf(a, ctx.home)))) stale.push(`${a.name}: CLAUDE.md`);
    }
    return stale.length === 0 ? ok() : todo(stale.join(', '));
  },
  async apply(ctx) {
    for (const a of scoped(ctx)) {
      await ctx.exec.mkdirp(effectiveClaudeDir(a, ctx.home), { mode: 0o700 });
      await ctx.exec.writeText(settingsPathOf(a, ctx.home), await wantedSettings(ctx, a), { description: `merge devhost settings into ${settingsPathOf(a, ctx.home)}` });
      await ctx.exec.writeText(claudeMdPathOf(a, ctx.home), await wantedClaudeMd(ctx, a), { description: `update the devhost block in ${claudeMdPathOf(a, ctx.home)}` });
    }
  },
};
