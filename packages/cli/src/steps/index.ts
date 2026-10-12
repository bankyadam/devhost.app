import type { DevhostConfig } from '@devhost/contract';
import { UsageError } from '../errors.js';
import { claudeBinaryStep, accountsClaudeStep } from './claude.js';
import { collectorStep } from './collector.js';
import { dockerSteps } from './docker.js';
import { envSteps } from './env.js';
import { gitStep } from './git.js';
import { packagesStep } from './packages.js';
import { routingStep } from './routing.js';
import { runtimesStep } from './runtimes.js';
import { shellStep } from './shell.js';
import { systemSteps } from './system.js';
import { tailscaleStep } from './tailscale.js';
import type { Step } from './types.js';

/**
 * All steps in execution order for this config. Environment steps (phase 3) and the
 * collector service (phase 4) are appended by their own modules via `extraSteps`.
 */
export function buildSteps(config: DevhostConfig, extra: (config: DevhostConfig) => Step[] = extraSteps): Step[] {
  return [
    ...systemSteps,
    packagesStep,
    runtimesStep,
    shellStep,
    ...dockerSteps,
    tailscaleStep,
    claudeBinaryStep,
    accountsClaudeStep,
    routingStep,
    gitStep,
    collectorStep,
    ...envSteps(config),
    ...extra(config),
  ];
}

/** Registered by later modules (environments, collector) to avoid import cycles. */
const extraProviders: ((config: DevhostConfig) => Step[])[] = [];
export function registerSteps(provider: (config: DevhostConfig) => Step[]): void {
  extraProviders.push(provider);
}
function extraSteps(config: DevhostConfig): Step[] {
  return extraProviders.flatMap((p) => p(config));
}

/** `--only system` selects every `system.*` step; `--only system.power` selects one. */
export function selectSteps(steps: Step[], only: string[]): Step[] {
  if (only.length === 0) return steps;
  const unknown = only.filter((o) => !steps.some((s) => s.id === o || s.id.startsWith(`${o}.`)));
  if (unknown.length > 0) {
    throw new UsageError(`unknown step: ${unknown.join(', ')}`, `Known steps: ${steps.map((s) => s.id).join(', ')}`);
  }
  return steps.filter((s) => only.some((o) => s.id === o || s.id.startsWith(`${o}.`)));
}
