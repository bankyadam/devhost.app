import { UsageError } from '../errors.js';
import { packagesStep } from './packages.js';
import { runtimesStep } from './runtimes.js';
import { shellStep } from './shell.js';
import { systemSteps } from './system.js';
import type { Step } from './types.js';

/** All steps in execution order. Later phases insert docker, tailscale, claude, accounts, environments. */
export const allSteps: Step[] = [...systemSteps, packagesStep, runtimesStep, shellStep];

/** `--only system` selects every `system.*` step; `--only system.power` selects one. */
export function selectSteps(steps: Step[], only: string[]): Step[] {
  if (only.length === 0) return steps;
  const unknown = only.filter((o) => !steps.some((s) => s.id === o || s.id.startsWith(`${o}.`)));
  if (unknown.length > 0) {
    throw new UsageError(`unknown step: ${unknown.join(', ')}`, `Known steps: ${steps.map((s) => s.id).join(', ')}`);
  }
  return steps.filter((s) => only.some((o) => s.id === o || s.id.startsWith(`${o}.`)));
}
