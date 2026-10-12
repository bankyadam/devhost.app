import type { ApplyData } from '@devhost/contract';
import { DevhostError } from './errors.js';
import type { Reporter } from './reporter.js';
import type { Step, StepContext } from './steps/types.js';

export interface ApplyOutcome {
  data: ApplyData;
  /** The error that stopped the run, if any. */
  error: DevhostError | Error | null;
  cancelled: boolean;
}

/**
 * Run steps in order (spec A7). A step whose check passes is left alone, so a
 * second run reports no changes. In a dry-run, steps that would change
 * something still run `apply()`, but every side effect only lands in the plan.
 */
export async function runSteps(
  steps: Step[],
  ctx: StepContext,
  reporter: Reporter,
  cancel: { cancelled: boolean },
): Promise<ApplyOutcome> {
  const { exec } = ctx;
  const results: ApplyData['steps'] = [];
  let error: ApplyOutcome['error'] = null;
  let cancelled = false;

  for (const step of steps) {
    if (cancel.cancelled) {
      cancelled = true;
      break;
    }
    exec.beginStep(step.id);
    reporter.step(step.id, 'start', step.description);
    try {
      const before = await step.check(ctx);
      if (before.state === 'skip') {
        results.push({ id: step.id, description: step.description, status: 'skipped', message: before.reason });
        reporter.step(step.id, 'skipped', before.reason);
        continue;
      }
      if (before.state === 'ok') {
        results.push({ id: step.id, description: step.description, status: 'ok' });
        reporter.step(step.id, 'ok');
        continue;
      }

      await step.apply(ctx);
      if (!exec.dryRun) {
        const after = await step.check(ctx);
        if (after.state === 'todo') {
          throw new DevhostError(
            `${step.id}: applied, but the check still fails (${after.reason})`,
            'step-verify-failed',
            1,
            'Run `devhost apply --verbose` to see the commands, or fix it by hand.',
          );
        }
      }
      const message = exec.dryRun ? `would change: ${before.reason}` : before.reason;
      results.push({ id: step.id, description: step.description, status: 'changed', message });
      reporter.step(step.id, 'changed', message);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      const message = error.message;
      results.push({ id: step.id, description: step.description, status: 'failed', message });
      reporter.step(step.id, 'failed', message);
      break;
    }
  }

  return {
    data: {
      dryRun: exec.dryRun,
      changed: results.some((r) => r.status === 'changed'),
      steps: results,
      plan: exec.plan,
      ...(exec.warnings.length > 0 ? { warnings: exec.warnings } : {}),
    },
    error,
    cancelled,
  };
}
