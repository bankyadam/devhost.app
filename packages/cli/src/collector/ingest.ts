import type { Db } from './db.js';
import { locate, parseHook, stateForEvent, type EnvLocation } from './hooks.js';
import { CumulativeTracker, parseLogs, parseMetrics, type Attribution } from './otlp.js';

/** Writes received telemetry to SQLite. Stateless apart from the cumulative-counter tracker. */
export class Ingestor {
  private readonly tracker = new CumulativeTracker();

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly locations: () => EnvLocation[],
  ) {}

  private readonly attribution: Attribution = {
    emailToAccount: (email) => this.db.kvGet(`email:${email}`) ?? undefined,
    learn: (email, account) => {
      if (this.db.kvGet(`email:${email}`) !== account) this.db.kvSet(`email:${email}`, account, this.now());
    },
    ownerOf: (org, email) => (org ? this.db.kvGet(`auth_org:${org}`) : null) ?? (email ? this.db.kvGet(`auth_email:${email}`) : null) ?? undefined,
    claim: (sessionId, account) => {
      if (this.db.kvGet(`session_owner:${sessionId}`) === account) return;
      this.db.kvSet(`session_owner:${sessionId}`, account, this.now());
      moveSessionHistory(this.db, sessionId, account);
    },
  };

  metrics(body: unknown): number {
    const now = this.now();
    const rows = parseMetrics(body, now, this.tracker, this.attribution);
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run('INSERT INTO usage (ts, account, env, session_id, model, kind, value) VALUES (?, ?, ?, ?, ?, ?, ?)', r.ts, r.account, r.env, r.sessionId, r.model, r.kind, r.value);
      }
    });
    this.db.kvSet('last_otel_at', String(now), now);
    return rows.length;
  }

  logs(body: unknown): number {
    const now = this.now();
    const rows = parseLogs(body, now, this.attribution);
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          'INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          r.ts, r.account, r.env, r.sessionId, r.model, r.input, r.output, r.cacheRead, r.cacheCreation, r.costUsd, r.durationMs,
        );
      }
    });
    this.db.kvSet('last_otel_at', String(now), now);
    return rows.length;
  }

  /** Session lifecycle and live state; stores event type, session id, cwd and timestamps only. */
  hook(body: unknown, accountFromUrl: string): boolean {
    const evt = parseHook(body);
    if (!evt) return false;
    const now = this.now();
    const where = locate(this.locations(), evt.cwd);
    // A login seen in the session's telemetry beats the directory and the hook URL (see ownerOf).
    const account = this.db.kvGet(`session_owner:${evt.sessionId}`) ?? where?.account ?? accountFromUrl;
    const env = where?.env ?? '';
    const state = stateForEvent(evt.event)!;
    this.db.transaction(() => {
      this.db.run('INSERT INTO hook_events (ts, session_id, account, event, cwd) VALUES (?, ?, ?, ?, ?)', now, evt.sessionId, account, evt.event, evt.cwd);
      this.db.run(
        `INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           state = excluded.state,
           last_activity_at = excluded.last_activity_at,
           cwd = CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE sessions.cwd END,
           account = CASE WHEN excluded.account <> '' THEN excluded.account ELSE sessions.account END,
           env = CASE WHEN excluded.env <> '' THEN excluded.env ELSE sessions.env END,
           ended_at = excluded.ended_at`,
        evt.sessionId, account, env, evt.cwd, state, now, now, state === 'ended' ? now : null,
      );
    });
    this.db.kvSet('last_hook_at', String(now), now);
    return true;
  }
}

/**
 * A session's whole history moves to its owner: rows written before the owner was known (the org
 * id is not stored per row, so ended sessions cannot be re-attributed later).
 */
export function moveSessionHistory(db: Db, sessionId: string, account: string): void {
  db.transaction(() => {
    for (const table of ['sessions', 'usage', 'api_requests', 'hook_events']) {
      db.run(`UPDATE ${table} SET account = ? WHERE session_id = ?`, account, sessionId);
    }
    // Rollups are keyed by account too: add into the owner's rows instead of colliding with them.
    db.run(
      `INSERT INTO rollup_usage (hour, account, env, session_id, model, kind, value)
       SELECT hour, ?, env, session_id, model, kind, SUM(value) FROM rollup_usage WHERE session_id = ? AND account <> ? GROUP BY hour, env, model, kind
       ON CONFLICT (hour, account, env, session_id, model, kind) DO UPDATE SET value = value + excluded.value`,
      account, sessionId, account,
    );
    db.run('DELETE FROM rollup_usage WHERE session_id = ? AND account <> ?', sessionId, account);
  });
}
