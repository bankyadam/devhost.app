import YAML, { isMap, isScalar, isSeq } from 'yaml';

/** Read a value at a JSON pointer from YAML text; `undefined` when absent or the text is not valid YAML. */
export function readAt(text: string, tokens: string[]): unknown {
  try {
    let cur: unknown = YAML.parse(text);
    for (const t of tokens) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
    return cur;
  } catch {
    return undefined;
  }
}

/**
 * Set a value in YAML text, keeping comments and formatting (the same approach the CLI uses for
 * `config set`). Returns the new text, or the old text unchanged if it is not valid YAML.
 */
export function writeAt(text: string, tokens: string[], value: unknown): string {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0 || tokens.length === 0) return text;
  const node = doc.getIn(tokens, true);
  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    // Overwriting keeps trailing comments. Quotes stay only where plain text would change meaning
    // (e.g. "3.12"); a field that went through `""` while being typed does not stay quoted.
    if (typeof value === 'string' && value !== '' && roundTripsPlain(value)) node.type = 'PLAIN';
    node.value = value;
  }
  else if (isMap(node) || isSeq(node) || node === undefined || node === null || isScalar(node)) doc.setIn(tokens, doc.createNode(value));
  return doc.toString();
}

function roundTripsPlain(v: string): boolean {
  try {
    return YAML.parse(v) === v;
  } catch {
    return false;
  }
}

/** Remove a key, e.g. when a form field is cleared back to its default. */
export function deleteAt(text: string, tokens: string[]): string {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) return text;
  doc.deleteIn(tokens);
  return doc.toString();
}

export const toPointer = (tokens: string[]): string => `/${tokens.map((t) => t.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
export const fromPointer = (p: string): string[] => (p === '' || p === '/' ? [] : p.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')));
