import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';
import { rollupProfile } from './profile.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Telemetry for an hour can arrive late (batched exporters): an hour is rolled up this long after it ended. */
const GRACE_MS = 5 * 60_000;
/** The last hours are rolled up again each run, so late rows still reach the rollups. */
const REROLL_MS = 2 * HOUR;

/**
 * Hourly rollups per account, environment, session and model (spec A10.3).
 * Completed hours are summed into `rollup_usage`; samples into `rollup_env`.
 */
export function rollup(db: Db, now: number): void {
  const upTo = Math.floor((now - GRACE_MS) / HOUR) * HOUR;
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  if (upTo <= rolled - REROLL_MS) return;
  const from = rolled > 0 ? Math.max(0, rolled - REROLL_MS) : 0;
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
    db.run(
      `INSERT OR REPLACE INTO rollup_source (hour, account, env, source, model, requests, input, output, cache_read, cache_creation, cost_usd)
       SELECT (ts / ${HOUR}) * ${HOUR}, account, env, source, model, COUNT(*), SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
         SUM(COALESCE(cache_read_tokens, 0)), SUM(COALESCE(cache_creation_tokens, 0)), SUM(COALESCE(cost_usd, 0)) FROM api_requests
       WHERE ts >= ? AND ts < ? AND source <> '' GROUP BY 1, account, env, source, model`,
      from, upTo,
    );
    rollupProfile(db, from, upTo);
    db.kvSet('rolled_through', String(Math.max(rolled, upTo)), now);
  });
}

export interface Retention {
  rawDays: number;
  rollupDays: number;
}

/** Drop raw data past `rawDays` (only once rolled up) and rollups past `rollupDays`. */
export function retain(db: Db, now: number, r: Retention): void {
  const rolled = Number(db.kvGet('rolled_through') ?? 0);
  // Raw rows stay until they cannot be rolled up again (see REROLL_MS).
  const rawCutoff = Math.min(now - r.rawDays * DAY, rolled - REROLL_MS);
  db.transaction(() => {
    for (const table of ['usage', 'api_requests', 'tool_runs', 'hook_events', 'samples_system', 'samples_env', 'samples_session', 'samples_agents', 'samples_collector', 'service_events']) {
      db.run(`DELETE FROM ${table} WHERE ts < ?`, rawCutoff);
    }
    db.run("DELETE FROM sessions WHERE state = 'ended' AND ended_at < ?", rawCutoff);
    db.run("DELETE FROM kv WHERE key LIKE 'session_owner:%' AND updated_at < ?", rawCutoff);
    db.run('DELETE FROM rollup_usage WHERE hour < ?', now - r.rollupDays * DAY);
    db.run('DELETE FROM rollup_env WHERE hour < ?', now - r.rollupDays * DAY);
    db.run('DELETE FROM rollup_agents WHERE hour < ?', now - r.rollupDays * DAY);
    for (const table of ['rollup_profile', 'rollup_tools', 'rollup_memory', 'rollup_source']) db.run(`DELETE FROM ${table} WHERE hour < ?`, now - r.rollupDays * DAY);
    db.run('DELETE FROM agents WHERE ended_at IS NOT NULL AND ended_at < ?', rawCutoff);
    // Side data in kv that nothing else cleans up. Learned emails live as long as the rollups.
    db.run("DELETE FROM kv WHERE (key LIKE 'handoff\\_failed:%' ESCAPE '\\' OR key LIKE 'awake:%' OR key LIKE 'cum:%') AND updated_at < ?", rawCutoff);
    db.run("DELETE FROM kv WHERE key LIKE 'email:%' AND updated_at < ?", now - r.rollupDays * DAY);
    // Login facts are rewritten at every auth check: untouched for a week means the account is gone.
    db.run("DELETE FROM kv WHERE substr(key, 1, 5) IN ('auth:', 'auth_') AND updated_at < ?", now - 7 * DAY);
  });
}

/** Delete handoff notes (files) older than `days` (at least 30: a note outlives its raw session data). */
export async function pruneHandoffNotes(home: string, now: number, days: number): Promise<void> {
  const dir = join(home, '.local', 'share', 'devhost', 'handoff');
  const cutoff = now - Math.max(days, 30) * DAY;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      if ((await stat(join(dir, name))).mtimeMs < cutoff) await unlink(join(dir, name));
    } catch {
      /* gone already */
    }
  }
}
