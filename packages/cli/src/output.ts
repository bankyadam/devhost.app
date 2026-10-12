import { CONTRACT_VERSION, ExitCode, type Envelope, type Event } from '@devhost/contract';
import type { Deps } from './deps.js';
import { ConfigError, DevhostError } from './errors.js';

export type ErrorEntry = Envelope['errors'][number];

export function errorEntries(err: unknown): ErrorEntry[] {
  if (err instanceof ConfigError && err.issues.length > 0) {
    return err.issues.map((i) => ({
      code: err.code,
      message: `${i.path || '/'}: ${i.message}`,
      path: i.path,
      ...(err.hint ? { hint: err.hint } : {}),
    }));
  }
  if (err instanceof DevhostError) {
    return [{ code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }];
  }
  return [{ code: 'internal', message: err instanceof Error ? err.message : String(err) }];
}

export function exitCodeFor(err: unknown): number {
  return err instanceof DevhostError ? err.exitCode : ExitCode.ChecksFailed;
}

/** Short commands: one JSON object on stdout (spec A9). */
export function writeEnvelope(deps: Deps, ok: boolean, data: unknown, errors: ErrorEntry[] = []): void {
  const envelope: Envelope = { contractVersion: CONTRACT_VERSION, ok, data: data ?? null, errors };
  deps.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/** Long-running commands: the last NDJSON line. */
export function writeResultEvent(deps: Deps, ok: boolean, data: unknown, errors: ErrorEntry[] = []): void {
  const event: Event = { type: 'result', ok, data: data ?? null, ...(errors.length > 0 ? { errors } : {}) };
  deps.stdout.write(`${JSON.stringify(event)}\n`);
}

export function writeHumanError(deps: Deps, err: unknown): void {
  for (const e of errorEntries(err)) {
    deps.stderr.write(`❌ ${e.message}\n`);
    if (e.hint) deps.stderr.write(`   ${e.hint.replace(/\n/g, '\n   ')}\n`);
  }
}
