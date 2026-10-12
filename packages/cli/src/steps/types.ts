import type { DevhostConfig } from '@devhost/contract';
import type { Executor } from '../runner/executor.js';

export interface StepContext {
  config: DevhostConfig;
  home: string;
  exec: Executor;
}

export type CheckResult =
  | { state: 'ok' }
  /** The system differs from the config; `reason` says how. */
  | { state: 'todo'; reason: string }
  | { state: 'skip'; reason: string };

export const ok = (): CheckResult => ({ state: 'ok' });
export const todo = (reason: string): CheckResult => ({ state: 'todo', reason });
export const skip = (reason: string): CheckResult => ({ state: 'skip', reason });

/** One idempotent unit of `devhost apply` (spec A7). */
export interface Step {
  /** Stable id used in events and `--only`, e.g. "system.power". */
  id: string;
  description: string;
  /** Read-only: compare the system with the config. */
  check(ctx: StepContext): Promise<CheckResult>;
  /** Make the system match. Must go through ctx.exec so --dry-run is safe. */
  apply(ctx: StepContext): Promise<void>;
}
