import { join } from 'node:path';
import { accountRoot, accountsOf, claudeConfigDir, type Account } from '../config/accounts.js';
import { whichBinary } from '../state.js';
import { ok, skip, todo, type Step, type StepContext } from './types.js';

export const ENVRC_HEADER = '# Managed by devhost. Selects this account\'s Claude config for everything below this directory.';

/** `<root>/.envrc`: only for accounts with their own config dir; never inside a repo (spec A7.6). */
export function accountEnvrc(a: Account, home: string): string | null {
  const dir = claudeConfigDir(a, home);
  return dir ? `${ENVRC_HEADER}\nexport CLAUDE_CONFIG_DIR=${shellQuote(dir)}\n` : null;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function scoped(ctx: StepContext): Account[] {
  return accountsOf(ctx.config).filter((a) => !ctx.onlyAccount || a.name === ctx.onlyAccount);
}

/** direnv reports `Found RC allowed 0` for a trusted .envrc. */
async function envrcAllowed(ctx: StepContext, root: string): Promise<boolean> {
  const r = await ctx.exec.query('direnv', ['status'], { cwd: root });
  return /Found RC allowed 0/.test(r.stdout);
}

/**
 * Only accounts with their own config dir need direnv. `account add` runs without the packages
 * step, and direnv joins the Brewfile only once an account exists, so the first such account
 * would otherwise find no direnv.
 */
const needsDirenv = (ctx: StepContext): boolean => scoped(ctx).some((a) => accountEnvrc(a, ctx.home) !== null);

export const routingStep: Step = {
  id: 'accounts.routing',
  description: 'Create account roots and route CLAUDE_CONFIG_DIR with direnv',
  async check(ctx) {
    const accounts = scoped(ctx);
    if (accounts.length === 0) return skip('no accounts configured');
    if (needsDirenv(ctx) && !(await whichBinary(ctx.exec, 'direnv'))) return todo('direnv is not installed');
    const problems: string[] = [];
    for (const a of accounts) {
      const root = accountRoot(a, ctx.home);
      const want = accountEnvrc(a, ctx.home);
      const rootExists = (await ctx.exec.query('test', ['-d', root])).code === 0;
      if (!rootExists) {
        problems.push(`${a.name}: ${root} is missing`);
        continue;
      }
      if (want === null) continue;
      if ((await ctx.exec.readText(join(root, '.envrc'))) !== want) problems.push(`${a.name}: .envrc`);
      else if (!(await envrcAllowed(ctx, root))) problems.push(`${a.name}: .envrc is not allowed in direnv`);
    }
    return problems.length === 0 ? ok() : todo(problems.join(', '));
  },
  async apply(ctx) {
    if (needsDirenv(ctx) && !(await whichBinary(ctx.exec, 'direnv'))) {
      await ctx.exec.exec('brew', ['install', 'direnv'], {
        reason: 'direnv routes CLAUDE_CONFIG_DIR per account and is not installed yet',
        env: { HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1' },
      });
    }
    for (const a of scoped(ctx)) {
      const root = accountRoot(a, ctx.home);
      await ctx.exec.mkdirp(root);
      const want = accountEnvrc(a, ctx.home);
      if (want === null) continue;
      await ctx.exec.writeText(join(root, '.envrc'), want, { description: `write ${join(root, '.envrc')}` });
      await ctx.exec.exec('direnv', ['allow', root]);
    }
  },
};
