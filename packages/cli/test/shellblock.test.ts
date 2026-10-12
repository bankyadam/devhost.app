import { describe, expect, it } from 'vitest';
import { DevhostError } from '../src/errors.js';
import { BLOCK_END, BLOCK_START, readBlock, removeBlock, upsertBlock } from '../src/steps/shellblock.js';

describe('shell block', () => {
  const body = ['echo one', 'echo two'];

  it('appends to an empty or existing file without touching other lines', () => {
    expect(upsertBlock('', body)).toBe(`${BLOCK_START}\necho one\necho two\n${BLOCK_END}\n`);
    const out = upsertBlock('export A=1', body);
    expect(out.startsWith('export A=1\n\n' + BLOCK_START)).toBe(true);
  });

  it('replaces only its own block, and is idempotent', () => {
    const original = `export A=1\n\n${BLOCK_START}\nold\n${BLOCK_END}\nexport B=2\n`;
    const once = upsertBlock(original, body);
    expect(once).toContain('export A=1');
    expect(once).toContain('export B=2');
    expect(once).not.toContain('old');
    expect(upsertBlock(once, body)).toBe(once);
    expect(readBlock(once)).toEqual(body);
  });

  it('removes the block and restores the original text', () => {
    const original = 'export A=1\n';
    expect(removeBlock(upsertBlock(original, body))).toBe(original);
    expect(removeBlock(original)).toBe(original);
  });

  it('refuses to touch a damaged block', () => {
    expect(() => upsertBlock(`${BLOCK_START}\nno end\n`, body)).toThrow(DevhostError);
    expect(() => upsertBlock(`${BLOCK_END}\n${BLOCK_START}\n`, body)).toThrow(DevhostError);
  });
});
