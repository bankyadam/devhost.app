/** Number of categorical slots in the validated palette (see styles.css). */
export const SERIES_SLOTS = 8;

/**
 * Color follows the entity, never its rank: an account keeps its slot no matter what a filter
 * hides. The slot is the account's position in the full account list; past eight the account
 * folds into "Other" (slot 0 = neutral).
 */
export function seriesSlot(allAccounts: readonly string[], name: string): number {
  const i = allAccounts.indexOf(name);
  return i >= 0 && i < SERIES_SLOTS ? i + 1 : 0;
}

export const seriesVar = (slot: number): string => (slot === 0 ? 'var(--series-other)' : `var(--series-${slot})`);
