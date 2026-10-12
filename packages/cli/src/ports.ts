import type { DevhostConfig } from '@devhost/contract';
import { accountsOf, environmentsOf, type Account } from './config/accounts.js';

export const ACCOUNT_BLOCK = 1000;
export const ENV_BLOCK = 100;
const FIRST_ACCOUNT_PORT = 3000;

/** Next free 1000-port block from 3000 (spec A7.11). */
export function allocateAccountRange(config: DevhostConfig): [number, number] {
  const taken = accountsOf(config).map((a) => a.portRange);
  for (let start = FIRST_ACCOUNT_PORT; start + ACCOUNT_BLOCK - 1 <= 65535; start += ACCOUNT_BLOCK) {
    const end = start + ACCOUNT_BLOCK - 1;
    if (!taken.some(([lo, hi]) => lo <= end && start <= hi)) return [start, end];
  }
  throw new Error('no free port range left');
}

/** Next free 100-port block inside the account's range that avoids other blocks and the collector port. */
export function allocatePortBase(config: DevhostConfig, account: Account, extraTaken: number[] = []): number {
  const [lo, hi] = account.portRange;
  const taken = [...environmentsOf(config).flatMap((e) => (e.portBase === undefined ? [] : [e.portBase])), ...extraTaken];
  const collector = config.collector?.port ?? 4318;
  for (let start = Math.ceil(lo / ENV_BLOCK) * ENV_BLOCK; start + ENV_BLOCK - 1 <= hi; start += ENV_BLOCK) {
    const free = !taken.some((t) => Math.abs(t - start) < ENV_BLOCK);
    if (free && !(collector >= start && collector < start + ENV_BLOCK)) return start;
  }
  throw new Error(`account "${account.name}" has no free ${ENV_BLOCK}-port block left in ${lo}-${hi}`);
}

/** Port bases for environments that lack one, in config order. */
export function missingPortBases(config: DevhostConfig): Map<string, number> {
  const out = new Map<string, number>();
  const extra: number[] = [];
  for (const e of environmentsOf(config)) {
    if (e.portBase !== undefined) continue;
    const account = accountsOf(config).find((a) => a.name === e.account);
    if (!account) continue;
    const base = allocatePortBase(config, account, extra);
    out.set(e.name, base);
    extra.push(base);
  }
  return out;
}
