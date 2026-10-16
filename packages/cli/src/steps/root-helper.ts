import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { templatesDir } from '../paths.js';
import { HELPER_PATH, installedHelperPath, installedSudoersPath, stagedHelperPath, stagedSudoersPath, sudoersRule } from '../root-helper.js';
import { ok, skip, todo, type Step, type StepContext } from './types.js';

const helperSource = (): Promise<string> => readFile(join(templatesDir, 'devhost-root.js'), 'utf8');

/** Owner and permissions as `user:mode`, e.g. `root:755`. */
async function ownerMode(ctx: StepContext, path: string): Promise<string | null> {
  const r = await ctx.exec.query('stat', ['-f', '%Su:%Lp', path]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function installed(ctx: StepContext): Promise<{ helper: boolean; sudoers: boolean }> {
  return {
    helper: (await ctx.exec.readText(installedHelperPath())) !== null,
    sudoers: (await ctx.exec.query('test', ['-e', installedSudoersPath()])).code === 0,
  };
}

/** The rule first, so sudo never points at a missing helper. */
export async function removeRootHelper(ctx: StepContext, why: string): Promise<void> {
  for (const path of [installedSudoersPath(), installedHelperPath()]) {
    await ctx.exec.exec('rm', ['-f', path], { sudo: true, reason: `remove ${path} (${why})` });
  }
}

/**
 * machine.rootHelper: the root helper and the sudoers rule that lets this user run it without a
 * password (root-helper.ts). Installing or updating them asks for the password once; everything
 * the helper does afterwards does not.
 */
export const rootHelperStep: Step = {
  id: 'system.helper',
  description: 'Root helper: devhost root operations without the sudo password',
  async check(ctx) {
    const have = await installed(ctx);
    if (ctx.config.machine.rootHelper !== true) {
      return have.helper || have.sudoers ? todo('the root helper is installed but machine.rootHelper is false') : skip('machine.rootHelper is false');
    }
    if ((await ctx.exec.readText(installedHelperPath())) !== (await helperSource())) return todo(have.helper ? 'the root helper is out of date' : 'the root helper is not installed');
    if ((await ownerMode(ctx, installedHelperPath())) !== 'root:755') return todo('the root helper must be root:wheel 0755');
    if (!have.sudoers || (await ctx.exec.query('sudo', ['-n', '-l', HELPER_PATH])).code !== 0) return todo('sudo does not allow the root helper without a password yet');
    return ok();
  },
  async apply(ctx) {
    const { exec, home } = ctx;
    if (ctx.config.machine.rootHelper !== true) return removeRootHelper(ctx, 'machine.rootHelper is false');
    await exec.writeText(stagedHelperPath(home), await helperSource(), { description: `stage ${stagedHelperPath(home)}` });
    await exec.writeText(stagedSudoersPath(home), sudoersRule(ctx.user), { description: `stage ${stagedSudoersPath(home)}` });
    await exec.exec('mkdir', ['-p', '-m', '755', installedHelperPath().replace(/\/[^/]+$/, '')], { sudo: true, reason: 'create the directory for the root helper' });
    await exec.exec('install', ['-m', '755', '-o', 'root', '-g', 'wheel', stagedHelperPath(home), installedHelperPath()], { sudo: true, reason: `install the root helper ${installedHelperPath()}` });
    // A broken sudoers file locks sudo out: check it before it is installed.
    await exec.exec('visudo', ['-c', '-f', stagedSudoersPath(home)], { sudo: true, reason: 'check the sudoers rule' });
    await exec.exec('install', ['-m', '440', '-o', 'root', '-g', 'wheel', stagedSudoersPath(home), installedSudoersPath()], {
      sudo: true,
      reason: `allow ${ctx.user} to run the root helper without a password (${installedSudoersPath()})`,
    });
  },
};
