// Browser-safe entry: types, constants and schemas, but no validator (ajv compiles schemas with
// `new Function`, which a desktop webview's CSP should not allow). The desktop app lets the CLI
// validate on the Mac mini and only uses the schemas to generate forms.
export * from './generated/types.js';
export { schemas, type SchemaName } from './generated/schemas.js';

export const CONTRACT_VERSION = 1;
export const CONTRACT_MINOR = 2;
/** Optional features of this contract revision (envelope.capabilities). */
export const CAPABILITIES: readonly string[] = ['snapshot-event'];

export const ExitCode = {
  Ok: 0,
  ChecksFailed: 1,
  Usage: 2,
  HumanActionRequired: 3,
  Cancelled: 130,
} as const;
