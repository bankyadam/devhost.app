import { writeFile } from 'node:fs/promises';
import YAML, { type Document } from 'yaml';
import type { DevhostConfig } from '@devhost/contract';
import { validateData } from './load.js';
import { ConfigError } from '../errors.js';
import { backupFile, readTextIfExists } from '../fsutil.js';

export interface EditResult {
  config: DevhostConfig;
  backup: string | null;
}

/**
 * Edit the config file in place: comments and formatting survive, the result is
 * validated before anything is written, and the previous file is backed up.
 */
export async function editConfigFile(path: string, now: Date, mutate: (doc: Document) => void): Promise<EditResult> {
  const raw = await readTextIfExists(path);
  if (raw === null) throw new ConfigError(`config not found: ${path}`, [], 'Run `devhost init` first.');
  const doc = YAML.parseDocument(raw);
  mutate(doc);
  const config = validateData(doc.toJS(), path);
  const backup = await backupFile(path, now);
  await writeFile(path, doc.toString(), { mode: 0o600 });
  return { config, backup };
}

/** Append a node to a top-level sequence, creating it when missing. */
export function appendTo(doc: Document, key: string, value: unknown): void {
  if (!doc.has(key) || doc.get(key) === null) doc.set(key, doc.createNode([]));
  doc.addIn([key], doc.createNode(value));
  // `accounts: []` is a flow sequence; a list of maps reads better as a block.
  const seq = doc.get(key, true);
  if (YAML.isSeq(seq)) seq.flow = false;
}

/** Remove the first item of a top-level sequence matching `pred`. */
export function removeFrom(doc: Document, key: string, pred: (item: Record<string, unknown>) => boolean): boolean {
  const seq = doc.get(key, true);
  if (!YAML.isSeq(seq)) return false;
  const idx = seq.items.findIndex((n) => pred((YAML.isNode(n) ? n.toJSON() : n) as Record<string, unknown>));
  if (idx < 0) return false;
  seq.items.splice(idx, 1);
  return true;
}
