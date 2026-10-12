import { DevhostError } from '../errors.js';

export const BLOCK_START = '# >>> devhost >>>';
export const BLOCK_END = '# <<< devhost <<<';

function locate(text: string, file: string): { start: number; end: number } | null {
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (l.trim() === BLOCK_START ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === BLOCK_END ? [i] : []));
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    throw new DevhostError(
      `${file} has a damaged devhost block (found ${starts.length} start and ${ends.length} end markers)`,
      'shell-block-damaged',
      1,
      `Fix or remove the lines between "${BLOCK_START}" and "${BLOCK_END}" by hand, then re-run.`,
    );
  }
  return { start: starts[0]!, end: ends[0]! };
}

export function renderBlock(body: string[]): string {
  return [BLOCK_START, ...body, BLOCK_END].join('\n');
}

/** Current body of the managed block, or null when there is none. */
export function readBlock(text: string, file = '~/.zshrc'): string[] | null {
  const loc = locate(text, file);
  return loc ? text.split('\n').slice(loc.start + 1, loc.end) : null;
}

/** Replace the managed block, or append it. Everything outside the block is left untouched. */
export function upsertBlock(text: string, body: string[], file = '~/.zshrc'): string {
  const block = renderBlock(body);
  const loc = locate(text, file);
  if (!loc) {
    if (text === '') return `${block}\n`;
    return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
  }
  const lines = text.split('\n');
  return [...lines.slice(0, loc.start), block, ...lines.slice(loc.end + 1)].join('\n');
}

/** Remove the managed block (used by `uninstall`). */
export function removeBlock(text: string, file = '~/.zshrc'): string {
  const loc = locate(text, file);
  if (!loc) return text;
  const lines = text.split('\n');
  const before = lines.slice(0, loc.start);
  // Drop the blank separator line upsertBlock added in front of the block.
  if (before.length > 0 && before[before.length - 1] === '') before.pop();
  return [...before, ...lines.slice(loc.end + 1)].join('\n');
}
