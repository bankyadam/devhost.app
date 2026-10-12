import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { accountRoot, accountsOf, type Account } from '../config/accounts.js';
import { devhostConfigDir } from '../config/paths.js';
import { hashBlock } from './shellblock.js';
import { ok, skip, todo, type Step } from './types.js';

export const gitDir = (home: string): string => join(devhostConfigDir(home), 'git');
export const accountGitConfigPath = (home: string, account: string): string => join(gitDir(home), `${account}.gitconfig`);

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function accountGitConfig(a: Account): string {
  return `[user]\n\tname = ${q(a.git.name)}\n\temail = ${q(a.git.email)}\n`;
}

/** Body of the managed block in ~/.gitconfig: one includeIf per account root. */
export function gitconfigBlockBody(config: DevhostConfig, home: string): string[] {
  return accountsOf(config).flatMap((a) => [
    `[includeIf "gitdir:${accountRoot(a, home).replace(/\/$/, '')}/"]`,
    `\tpath = ${accountGitConfigPath(home, a.name)}`,
  ]);
}

export const gitStep: Step = {
  id: 'accounts.git',
  description: 'Git identity per account root (includeIf)',
  async check({ config, home, exec }) {
    const accounts = accountsOf(config);
    const gitconfig = join(home, '.gitconfig');
    const text = (await exec.readText(gitconfig)) ?? '';
    const current = hashBlock.read(text, gitconfig);
    if (accounts.length === 0) return current === null ? skip('no accounts configured') : todo('the devhost block lists removed accounts');
    const problems: string[] = [];
    if (current?.join('\n') !== gitconfigBlockBody(config, home).join('\n')) problems.push('~/.gitconfig block');
    for (const a of accounts) {
      if ((await exec.readText(accountGitConfigPath(home, a.name))) !== accountGitConfig(a)) problems.push(`${a.name}.gitconfig`);
    }
    return problems.length === 0 ? ok() : todo(problems.join(', '));
  },
  async apply({ config, home, exec }) {
    const gitconfig = join(home, '.gitconfig');
    for (const a of accountsOf(config)) {
      await exec.writeText(accountGitConfigPath(home, a.name), accountGitConfig(a), { description: `write ${accountGitConfigPath(home, a.name)}` });
    }
    const text = (await exec.readText(gitconfig)) ?? '';
    const body = gitconfigBlockBody(config, home);
    const next = body.length === 0 ? hashBlock.remove(text, gitconfig) : hashBlock.upsert(text, body, gitconfig);
    if (next !== text) await exec.writeText(gitconfig, next, { description: `update the devhost block in ${gitconfig}` });
  },
};
