import type { Db } from './db.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Hourly rollups per account, environment, session and model (spec A10.3).
 * Completed hours are summed into `rollup_usage`; samples into `rollup_env`.
 */
export function rollup(db: Db, now: number): void {
  const upTo = Math.floor(now / HOUR) * HOUR;
  const from = Number(db.kvGet('rolled_through') ?? 0);
  if (upTo <= from) return;
  db.transaction(() => {
    db.run(
      `INSERT OR REPLACE INTO rollup_usage (hour, account, env, session_id, model, kind, value)
       SELECT (ts / ${HOUR}) * ${HOUR}, account, env, session_id, model, kind, SUM(value) FROM usage
       WHERE ts >= ? AND ts < ? GROUP BY 1, account, env, session_id, model, kind`,
      from, upTo,
    );
    db.run(
      `INSERT OR REPLACE INTO rollup_env (hour, account, env, cpu_avg, cpu_max, rss_avg, rss_max, samples)
       SELECT (ts / ${HOUR}) * ${HOUR}, account, env, AVG(cpu_pct), MAX(cpu_pct), AVG(rss_bytes), MAX(rss_bytes), COUNT(*) FROM samples_env
       WHERE ts >= ? AND ts < ? GROUP BY 1, account, env`,
      from, upTo,
    );
    db.run(
      `INSERT OR REPLACE INTO rollup_agents (hour, account, sessions_max, subagents_max, total_max, total_avg, samples)
       SELECT (ts / ${HOUR}) * ${HOUR}, account, MAX(sessions), MAX(subagents), MAX(sessions + subagents), AVG(sessions + subagents), COUNT(*) FROM samples_agents
       WHERE ts >= ? AND ts < ? GROUP BY 1, account`,
      from, upTo,
    );
    db.kvSet('rolled_through', String(upTo), now);
  });
}

export interface Retention {
  rawDays: number;
  rollupDays: number;
}

/** Drop raw data past `rawDays` (only once rolled up) and rollups past `rollupDays`. */
export function retain(db: Db, now: number, r: Retention): void {
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  const rawCutoff = Math.min(now - r.rawDays * DAY, rolled);
  db.transaction(() => {
    for (const table of ['usage', 'api_requests', 'hook_events', 'samples_system', 'samples_env', 'samples_session', 'samples_agents', 'service_events']) {
      db.run(`DELETE FROM ${table} WHERE ts < ?`, rawCutoff);
    }
    db.run("DELETE FROM sessions WHERE state = 'ended' AND ended_at < ?", rawCutoff);
    db.run("DELETE FROM kv WHERE key LIKE 'session_owner:%' AND updated_at < ?", rawCutoff);
    db.run('DELETE FROM rollup_usage WHERE hour < ?', now - r.rollupDays * DAY);
    db.run('DELETE FROM rollup_env WHERE hour < ?', now - r.rollupDays * DAY);
    db.run('DELETE FROM rollup_agents WHERE hour < ?', now - r.rollupDays * DAY);
    db.run('DELETE FROM agents WHERE ended_at IS NOT NULL AND ended_at < ?', rawCutoff);
  });
}
