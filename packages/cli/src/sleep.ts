import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { composeProject } from './config/accounts.js';
import type { Executor } from './runner/executor.js';

/**
 * Sleeping environments (spec A7.9): an environment's compose services are stopped while no session
 * uses it, and started again when one does. Only the services that ran when it fell asleep come
 * back: one stopped by hand (a model server left off on purpose) stays stopped.
 */
export interface SleepState {
  /** When it fell asleep (epoch ms). */
  at: number;
  /** The compose services that were running then: the ones a wake starts again. */
  services: string[];
}

export const sleepPath = (home: string, env: string): string => join(home, '.local', 'share', 'devhost', 'sleep', `${env}.json`);

export async function sleepState(home: string, env: string): Promise<SleepState | null> {
  try {
    const data = JSON.parse(await readFile(sleepPath(home, env), 'utf8')) as SleepState;
    return typeof data.at === 'number' && Array.isArray(data.services) ? data : null;
  } catch {
    return null;
  }
}

/** The compose services running now (paused ones count: they are meant to run), by name. */
export async function runningServices(exec: Executor, env: string, dir: string): Promise<string[]> {
  const r = await exec.query('docker', ['compose', '-p', composeProject(env), 'ps', '--format', '{{.Service}} {{.State}}'], { cwd: dir });
  if (r.code !== 0) return [];
  const up = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([name, state]) => name && (state === 'running' || state === 'paused'));
  return [...new Set(up.map(([name]) => name!))].sort();
}

/**
 * Put an environment to sleep: note the running services, then `docker compose stop` (containers
 * and volumes stay). Returns what it stopped; null when nothing ran (nothing to do).
 */
export async function sleepEnv(exec: Executor, home: string, env: string, dir: string, now: number): Promise<SleepState | null> {
  if (await sleepState(home, env)) return null;
  const services = await runningServices(exec, env, dir);
  if (services.length === 0) return null;
  const state: SleepState = { at: now, services };
  // Written first: a stop that half-works still knows what to start again.
  if (!exec.dryRun) {
    await mkdir(dirname(sleepPath(home, env)), { recursive: true });
    await writeFile(sleepPath(home, env), `${JSON.stringify(state)}\n`);
  }
  await exec.exec('docker', ['compose', '-p', composeProject(env), 'stop', ...services], { cwd: dir, reason: `put ${env} to sleep: stop ${services.join(', ')}` });
  return state;
}

/** Wake an environment: start the services that ran when it fell asleep. Returns them; null when it was awake. */
export async function wakeEnv(exec: Executor, home: string, env: string, dir: string): Promise<SleepState | null> {
  const state = await sleepState(home, env);
  if (!state) return null;
  await exec.exec('docker', ['compose', '-p', composeProject(env), 'start', ...state.services], { cwd: dir, reason: `wake ${env}: start ${state.services.join(', ')}` });
  if (!exec.dryRun) await rm(sleepPath(home, env), { force: true });
  return state;
}
