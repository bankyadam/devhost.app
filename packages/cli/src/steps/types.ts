import type { DevhostConfig } from '@devhost/contract';
import type { Executor } from '../runner/executor.js';

export interface StepContext {
  config: DevhostConfig;
  home: string;
  /** macOS account that runs services. */
  user: string;
  exec: Executor;
  /** Absolute path of the config file (the collector service needs it). */
  configPath: string;
  /** Restrict account-scoped steps to one account (used by `account add`). */
  onlyAccount?: string;
  /**
   * Called right before an environment's Remote Control service is installed.
   * `env create` and `login` use it to accept workspace trust interactively.
   */
  beforeService?: (info: EnvInfo) => Promise<void>;
}

export interface EnvInfo {
  name: string;
  account: string;
  dir: string;
  claudeConfigDir: string | null;
  spawn: string;
  permissionMode: string;
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
  /** Set to false for best-effort steps whose result cannot be fully verified (e.g. `brew uninstall` of a package others depend on). */
  verify?: boolean;
}
