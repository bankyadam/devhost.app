import YAML, { isMap, isScalar, isSeq, type Document } from 'yaml';
import { UsageError } from '../errors.js';

/** RFC 6901 JSON pointer → tokens. '' (or '/') addresses the whole document. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) {
    throw new UsageError(`invalid JSON pointer "${pointer}"`, 'Pointers start with "/", e.g. /machine/hostname');
  }
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function getByPointer(data: unknown, tokens: string[]): { found: boolean; value: unknown } {
  let cur: unknown = data;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(t) ? Number(t) : -1;
      if (idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, t)) {
      cur = (cur as Record<string, unknown>)[t];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

/** Parse a CLI value: JSON/YAML when it parses to something, plain string otherwise. */
export function parseValue(text: string): unknown {
  try {
    return YAML.parse(text);
  } catch {
    return text;
  }
}

/**
 * Set a value in a YAML document in place, preserving comments and formatting.
 * Numeric tokens index into sequences, "-" appends to one.
 */
export function setByPointer(doc: Document, tokens: string[], value: unknown): void {
  if (tokens.length === 0) throw new UsageError('refusing to replace the whole config', 'Use `devhost config edit`.');

  const path: (string | number)[] = [];
  let node: unknown = doc.contents;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const last = i === tokens.length - 1;
    if (isSeq(node)) {
      if (token === '-' && last) {
        node.add(doc.createNode(value));
        return;
      }
      if (!/^\d+$/.test(token)) throw new UsageError(`"${token}" is not an index into a list`);
      const idx = Number(token);
      if (idx > node.items.length || (idx === node.items.length && !last)) {
        throw new UsageError(`index ${idx} is out of range`);
      }
      path.push(idx);
      node = node.get(idx, true);
    } else {
      path.push(token);
      node = isMap(node) ? node.get(token, true) : undefined;
    }
  }
  // Overwrite a scalar in place so its trailing comment survives.
  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    node.value = value;
    return;
  }
  doc.setIn(path, doc.createNode(value));
}
