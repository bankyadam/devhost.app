import { DevhostError } from '../errors.js';

export interface BlockEditor {
  start: string;
  end: string;
  /** Current body of the managed block, or null when there is none. */
  read(text: string, file?: string): string[] | null;
  /** Replace the managed block, or append it. Everything outside the block is left untouched. */
  upsert(text: string, body: string[], file?: string): string;
  /** Remove the managed block (used by `uninstall` and `account remove`). */
  remove(text: string, file?: string): string;
}

/** Editor for a marker-delimited block inside a file the user also edits (zshrc, gitconfig, CLAUDE.md). */
export function blockEditor(start: string, end: string): BlockEditor {
  const locate = (text: string, file: string): { start: number; end: number } | null => {
    const lines = text.split('\n');
    const starts = lines.flatMap((l, i) => (l.trim() === start ? [i] : []));
    const ends = lines.flatMap((l, i) => (l.trim() === end ? [i] : []));
    if (starts.length === 0 && ends.length === 0) return null;
    if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
      throw new DevhostError(
        `${file} has a damaged devhost block (found ${starts.length} start and ${ends.length} end markers)`,
        'shell-block-damaged',
        1,
        `Fix or remove the lines between "${start}" and "${end}" by hand, then re-run.`,
      );
    }
    return { start: starts[0]!, end: ends[0]! };
  };
  const render = (body: string[]): string => [start, ...body, end].join('\n');

  return {
    start,
    end,
    read(text, file = 'file') {
      const loc = locate(text, file);
      return loc ? text.split('\n').slice(loc.start + 1, loc.end) : null;
    },
    upsert(text, body, file = 'file') {
      const block = render(body);
      const loc = locate(text, file);
      if (!loc) {
        if (text === '') return `${block}\n`;
        return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
      }
      const lines = text.split('\n');
      return [...lines.slice(0, loc.start), block, ...lines.slice(loc.end + 1)].join('\n');
    },
    remove(text, file = 'file') {
      const loc = locate(text, file);
      if (!loc) return text;
      const lines = text.split('\n');
      const before = lines.slice(0, loc.start);
      // Drop the blank separator line upsert added in front of the block.
      if (before.length > 0 && before[before.length - 1] === '') before.pop();
      return [...before, ...lines.slice(loc.end + 1)].join('\n');
    },
  };
}

export const BLOCK_START = '# >>> devhost >>>';
export const BLOCK_END = '# <<< devhost <<<';

/** `# >>> devhost >>>` block, used for ~/.zshrc and ~/.gitconfig (both accept # comments). */
export const hashBlock = blockEditor(BLOCK_START, BLOCK_END);

export const readBlock = hashBlock.read;
export const upsertBlock = hashBlock.upsert;
export const removeBlock = hashBlock.remove;

/** Block for Markdown files such as CLAUDE.md. */
export const markdownBlock = blockEditor('<!-- >>> devhost >>> -->', '<!-- <<< devhost <<< -->');
