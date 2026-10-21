import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { Db, dbPath } from '../../../cli/src/collector/db.js';
import { Ingestor } from '../../../cli/src/collector/ingest.js';
import { envLocations } from '../../../cli/src/collector/hooks.js';
import { parseConfig } from '../../../cli/src/config/load.js';
import { fakeMac, makeEnv, type TestEnv } from '../../../cli/test/helpers.js';
import { App } from '../../src/App';
import { InProcessTransport } from './inprocess';

afterEach(() => cleanup());

export interface Harness {
  env: TestEnv;
  mac: ReturnType<typeof fakeMac>;
  transport: InProcessTransport;
  user: ReturnType<typeof userEvent.setup>;
  /** Run a CLI command directly (set-up, not through the UI). */
  cli: (...args: string[]) => Promise<number>;
}

/** A converged fake Mac (init + apply) with the real CLI behind an in-process transport. */
export async function makeHarness(opts: { applied?: boolean } = {}): Promise<Harness> {
  const mac = fakeMac();
  const env = await makeEnv(mac.runner);
  env.deps.env['DEVHOST_TRUST_IDLE_MS'] = '30';
  await env.run('init', '--yes', '--no-tailscale');
  if (opts.applied !== false) await env.run('apply');
  env.out.length = 0;
  const transport = new InProcessTransport(env.deps);
  return { env, mac, transport, user: userEvent.setup(), cli: (...a) => env.run(...a) };
}

export const memoryStorage = (initial: Record<string, string> = {}) => {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

export const PREFS = JSON.stringify({ host: 'macmini', theme: 'light', range: '24h' });

export function mount(h: Harness, over: { retryMs?: number; heartbeatMs?: number } = {}) {
  return render(<App makeTransport={() => h.transport} storage={memoryStorage({ 'devhost.prefs.v1': PREFS })} retryMs={over.retryMs ?? 30} heartbeatMs={over.heartbeatMs ?? 60_000} />);
}

/** Pre-load answers for prompt events, in the order the CLI asks. */
export function feed(h: Harness, ...answers: object[]): void {
  const s = new PassThrough();
  h.env.deps.stdin = s;
  (h.transport as unknown as { base: { stdin: unknown } }).base.stdin = s;
  s.end(answers.map((a) => JSON.stringify(a)).join('\n') + '\n');
}

/** Add telemetry like the collector would have, so the dashboard has something to show. */
export function seedUsage(h: Harness, config: string): void {
  const cfg = parseConfig(config, '/c');
  const db = new Db(dbPath(h.env.home));
  const now = h.env.deps.now().getTime(); // the fake machine's clock, which `dash` also uses
  const ingest = new Ingestor(db, () => now, () => envLocations(cfg, h.env.home));
  const dir = join(h.env.home, 'work', 'business', 'acme-api');
  ingest.hook({ hook_event_name: 'SessionStart', session_id: 'sess-waiting-1', cwd: dir }, 'business');
  ingest.hook({ hook_event_name: 'Notification', session_id: 'sess-waiting-1', cwd: dir }, 'business');
  ingest.hook({ hook_event_name: 'SessionStart', session_id: 'sess-running-2', cwd: dir }, 'business');
  ingest.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-running-2', cwd: dir }, 'business');
  ingest.hook({ hook_event_name: 'SubagentStart', session_id: 'sess-running-2', cwd: dir, agent_id: 'agent-1', agent_type: 'Explore' }, 'business');
  ingest.hook({ hook_event_name: 'SubagentStart', session_id: 'sess-running-2', cwd: dir, agent_id: 'agent-2', agent_type: 'Plan' }, 'business');
  ingest.hook({ hook_event_name: 'SubagentStop', session_id: 'sess-running-2', cwd: dir, agent_id: 'agent-2', agent_type: 'Plan' }, 'business');
  const kv = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const point = (type: string, value: number, session: string) => ({ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [{ asDouble: value, attributes: [kv('type', type), kv('model', 'claude-sonnet-5-5'), kv('session.id', session)] }] } });
  ingest.metrics({
    resourceMetrics: [{ resource: { attributes: [kv('devhost.account', 'business'), kv('devhost.env', 'acme-api')] }, scopeMetrics: [{ metrics: [point('input', 1200, 'sess-waiting-1'), point('output', 300, 'sess-waiting-1'), point('input', 9000, 'sess-running-2'), { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 1, dataPoints: [{ asDouble: 1.5, attributes: [kv('model', 'claude-sonnet-5-5'), kv('session.id', 'sess-running-2')] }] } }] }] }],
  });
  db.run('INSERT INTO samples_system (ts, cpu_pct, mem_pct, mem_used, mem_total, disk_free_pct, disk_free_bytes, load1) VALUES (?, 12, 40, 1, 2, 60, 10, 1)', now);
  db.run("INSERT INTO samples_agents VALUES (?, '', 1, 1)", now);
  db.run("INSERT INTO samples_agents VALUES (?, '', 2, 3)", now - 3_600_000);
  db.run('INSERT INTO samples_env VALUES (?, ?, ?, 7, 52428800, NULL, NULL, 123)', now, 'business', 'acme-api');
  db.kvSet('docker', 'up', now);
  db.close();
}
