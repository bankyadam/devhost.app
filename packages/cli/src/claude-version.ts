/** The oldest Claude Code with Remote Control, as its own "too old" message named it in October 2026. */
export const MIN_REMOTE_CONTROL_VERSION = '2.1.139';

/** `2.1.81 (Claude Code)` → [2, 1, 81]; null when there is no version. */
export function parseVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(have: number[], min: string): boolean {
  const want = parseVersion(min)!;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! > want[i]!;
  return true;
}
