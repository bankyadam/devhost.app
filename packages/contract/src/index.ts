import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { DevhostConfig } from './generated/types.js';
import { schemas, type SchemaName } from './generated/schemas.js';

export * from './generated/types.js';
export { schemas, type SchemaName };

/** Version of the --json contract (spec A9). Bump the major on breaking changes. */
import { CONTRACT_VERSION as VERSION } from './lite.js';
export const CONTRACT_VERSION = VERSION;

/** Process exit codes (spec A9). */
export const ExitCode = {
  Ok: 0,
  ChecksFailed: 1,
  Usage: 2,
  HumanActionRequired: 3,
  Cancelled: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface ValidationIssue {
  /** JSON pointer to the offending value ('' = document root). */
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; value: undefined; issues: ValidationIssue[] };

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true, strictTypes: false });
const compiled = new Map<SchemaName, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    fn = ajv.compile(schemas[name]);
    compiled.set(name, fn);
  }
  return fn;
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => {
    let path = e.instancePath;
    let message = e.message ?? 'invalid';
    if (e.keyword === 'additionalProperties') {
      const extra = String((e.params as { additionalProperty?: string }).additionalProperty);
      path = `${path}/${extra}`;
      message = 'unknown property';
    } else if (e.keyword === 'required') {
      const missing = String((e.params as { missingProperty?: string }).missingProperty);
      path = `${path}/${missing}`;
      message = 'required property is missing';
    } else if (e.keyword === 'enum') {
      const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      message = `must be one of: ${allowed.map(String).join(', ')}`;
    }
    return { path, message };
  });
}

/**
 * Validate `input` against a named schema. The input is cloned first; schema
 * defaults are applied to the returned value, `input` is never mutated.
 */
export function validate<T = unknown>(name: SchemaName, input: unknown): ValidationResult<T> {
  const value = structuredClone(input);
  const fn = validatorFor(name);
  if (fn(value)) return { ok: true, value: value as T, issues: [] };
  return { ok: false, value: undefined, issues: toIssues(fn.errors) };
}

export function validateConfig(input: unknown): ValidationResult<DevhostConfig> {
  return validate('config', input);
}

export function assertValid(name: SchemaName, input: unknown): void {
  const r = validate(name, input);
  if (!r.ok) {
    throw new Error(`${name}: ${r.issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`);
  }
}
