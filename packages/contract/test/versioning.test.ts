import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CONTRACT_MINOR, CONTRACT_VERSION, ExitCode, schemas, validate } from '../src/index.js';
import * as lite from '../src/lite.js';

const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));

type Node = Record<string, unknown>;
/** Every path of a schema with the facts consumers rely on: type, const, enum, requiredness. */
function surface(node: unknown, path: string, out: Record<string, string>): void {
  if (node === null || typeof node !== 'object') return;
  const n = node as Node;
  out[path] = JSON.stringify({ type: n['type'], const: n['const'], enum: n['enum'] });
  for (const r of (n['required'] as string[] | undefined) ?? []) out[`${path}!required:${r}`] = 'required';
  for (const [k, v] of Object.entries((n['properties'] as Node | undefined) ?? {})) surface(v, `${path}.${k}`, out);
  if (n['items']) surface(n['items'], `${path}[]`, out);
  if (n['additionalProperties'] && typeof n['additionalProperties'] === 'object') surface(n['additionalProperties'], `${path}.*`, out);
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) ((n[key] as unknown[] | undefined) ?? []).forEach((v, i) => surface(v, `${path}|${key}${i}`, out));
}
const current = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, s] of Object.entries(schemas)) surface(s, name, out);
  return out;
};

describe('contract versioning', () => {
  it('has one ExitCode definition', () => {
    expect(ExitCode).toBe(lite.ExitCode);
  });

  it('advertises a minor version and capabilities', () => {
    expect(CONTRACT_MINOR).toBeGreaterThanOrEqual(1);
    expect(CAPABILITIES).toContain('snapshot-event');
    expect(validate('envelope', { contractVersion: 1, contractMinor: CONTRACT_MINOR, capabilities: [...CAPABILITIES], ok: true, data: {}, errors: [] }).ok).toBe(true);
  });

  it('validates the dash --follow snapshot event', () => {
    expect(validate('events', { type: 'snapshot', data: { range: '1h' } }).ok).toBe(true);
    expect(validate('events', { type: 'snapshot' }).ok).toBe(false);
  });

  it('forces a contractVersion bump on breaking schema changes and a minor bump on additions', () => {
    const now = current();
    if (process.env['UPDATE_CONTRACT_BASELINE']) {
      writeFileSync(baselinePath, `${JSON.stringify({ contractVersion: CONTRACT_VERSION, minor: CONTRACT_MINOR, surface: now }, null, 1)}\n`);
    }
    const base = JSON.parse(readFileSync(baselinePath, 'utf8')) as { contractVersion: number; minor: number; surface: Record<string, string> };
    const breaking: string[] = [];
    const additive: string[] = [];
    for (const [path, fact] of Object.entries(base.surface)) {
      if (!(path in now)) breaking.push(`removed ${path}`);
      else if (now[path] !== fact) {
        const [a, b] = [JSON.parse(fact) as { enum?: unknown[]; type?: unknown; const?: unknown }, JSON.parse(now[path]!) as { enum?: unknown[]; type?: unknown; const?: unknown }];
        const enumGrew = a.enum && b.enum && a.enum.every((v) => b.enum!.includes(v)) && JSON.stringify(a.type) === JSON.stringify(b.type);
        (enumGrew ? additive : breaking).push(`changed ${path}`);
      }
    }
    for (const path of Object.keys(now)) {
      if (path in base.surface) continue;
      (path.includes('!required:') ? breaking : additive).push(`added ${path}`);
    }
    const major = CONTRACT_VERSION > base.contractVersion;
    if (breaking.length > 0) expect(major, `breaking changes need a CONTRACT_VERSION bump (baseline ${base.contractVersion}):\n${breaking.join('\n')}`).toBe(true);
    if (additive.length > 0) expect(major || CONTRACT_MINOR > base.minor, `additive changes need a CONTRACT_MINOR bump (baseline ${base.minor}):\n${additive.join('\n')}`).toBe(true);
    // The schema's own version constant follows CONTRACT_VERSION.
    const envelope = schemas.envelope.properties.contractVersion as { const: number };
    expect(envelope.const).toBe(CONTRACT_VERSION);
  });
});
