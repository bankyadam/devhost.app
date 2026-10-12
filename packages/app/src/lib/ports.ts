const ENV_BLOCK = 100;
const ACCOUNT_BLOCK = 1000;
const FIRST_ACCOUNT_PORT = 3000;

/** Same rule as the CLI (`devhost env create`): first free 100-port block in the account range that avoids the collector. */
export function predictEnvBlock(range: readonly [number, number] | readonly number[], takenBases: readonly number[], collectorPort: number): number | null {
  const [lo, hi] = [range[0]!, range[1]!];
  for (let start = Math.ceil(lo / ENV_BLOCK) * ENV_BLOCK; start + ENV_BLOCK - 1 <= hi; start += ENV_BLOCK) {
    const free = !takenBases.some((t) => Math.abs(t - start) < ENV_BLOCK);
    if (free && !(collectorPort >= start && collectorPort < start + ENV_BLOCK)) return start;
  }
  return null;
}

/** Same rule as `devhost account add`: next free 1000-port block from 3000. */
export function predictAccountRange(taken: readonly (readonly number[])[]): [number, number] {
  for (let start = FIRST_ACCOUNT_PORT; start + ACCOUNT_BLOCK - 1 <= 65535; start += ACCOUNT_BLOCK) {
    const end = start + ACCOUNT_BLOCK - 1;
    if (!taken.some((r) => r[0]! <= end && start <= r[1]!)) return [start, end];
  }
  return [FIRST_ACCOUNT_PORT, FIRST_ACCOUNT_PORT + ACCOUNT_BLOCK - 1];
}

export const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
export const ENV_SLUG = /^[a-z][a-z0-9-]{0,47}$/;
