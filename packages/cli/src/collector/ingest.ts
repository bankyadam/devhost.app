import type { Db } from './db.js';
import { locate, parseHook, stateForEvent, turnOpenFor, type EnvLocation } from './hooks.js';
import { CumulativeTracker, parseLogs, parseMetrics, parseToolRuns, type Attribution } from './otlp.js';

/** Writes received telemetry to SQLite. Stateless apart from the cumulative-counter tracker. */
export class Ingestor {
  /** Cumulative counters are remembered in kv (`cum:*`, pruned by retention), so a restart does not count them twice. */
  private readonly tracker = new CumulativeTracker({
    get: (key) => {
      const v = this.db.kvGet(`cum:${key}`);
      return v === null ? undefined : Number(v);
    },
    set: (key, value) => this.db.kvSet(`cum:${key}`, String(value), this.now()),
  });

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly locations: () => EnvLocation[],
    /** A session started or got a prompt in this environment (wakes a sleeping one, A7.9). */
    private readonly onActive?: (where: EnvLocation) => void,
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
    this.touch(rows.map((r) => r.sessionId), now);
    return rows.length;
  }

  logs(body: unknown): number {
    const now = this.now();
    const rows = parseLogs(body, now, this.attribution);
    const tools = parseToolRuns(body, now, this.attribution);
    this.db.transaction(() => {
      // The time profile starts here: earlier API requests have no tool runs beside them.
      if (tools.length > 0) this.db.run("INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES ('profile_since', ?, ?)", String(Math.min(...tools.map((t) => t.ts - t.durationMs))), now);
      for (const t of tools) {
        this.db.run('INSERT INTO tool_runs (ts, account, env, session_id, tool, duration_ms, success) VALUES (?, ?, ?, ?, ?, ?, ?)', t.ts, t.account, t.env, t.sessionId, t.tool, t.durationMs, t.success === null ? null : t.success ? 1 : 0);
      }
      for (const r of rows) {
        this.db.run(
          'INSERT INTO api_requests (ts, account, env, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          r.ts, r.account, r.env, r.sessionId, r.model, r.input, r.output, r.cacheRead, r.cacheCreation, r.costUsd, r.durationMs, r.source,
        );
      }
    });
    this.db.kvSet('last_otel_at', String(now), now);
    this.touch([...rows.map((r) => r.sessionId), ...tools.map((t) => t.sessionId)], now);
    return rows.length + tools.length;
  }

  /** Telemetry from a session is activity: a long turn with no hook must not look quiet. */
  private touch(ids: (string | null | undefined)[], now: number): void {
    for (const id of new Set(ids)) if (id) this.db.run("UPDATE sessions SET last_activity_at = ? WHERE session_id = ? AND state <> 'ended' AND last_activity_at < ?", now, id, now);
  }

  /** Session lifecycle and live state; stores event type, session id, cwd and timestamps only. */
  hook(body: unknown, accountFromUrl: string): boolean {
    const evt = parseHook(body);
    if (!evt) return false;
    const now = this.now();
    if (evt.agentId) {
      const agentId = evt.agentId;
      this.db.transaction(() => {
        this.db.run('INSERT INTO hook_events (ts, session_id, account, event, cwd) VALUES (?, ?, ?, ?, ?)', now, evt.sessionId, this.db.kvGet(`session_owner:${evt.sessionId}`) ?? accountFromUrl, evt.event, evt.cwd);
        if (evt.event === 'SubagentStart') {
          this.db.run('INSERT INTO agents (agent_id, session_id, agent_type, started_at, ended_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(agent_id) DO NOTHING', agentId, evt.sessionId, evt.agentType ?? '', now);
        } else {
          // A stop without its start (devhost installed meanwhile) still counts as one that ran.
          this.db.run('INSERT INTO agents (agent_id, session_id, agent_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET ended_at = excluded.ended_at', agentId, evt.sessionId, evt.agentType ?? '', now, now);
        }
        this.db.run('UPDATE sessions SET last_activity_at = ? WHERE session_id = ?', now, evt.sessionId);
      });
      this.db.kvSet('last_hook_at', String(now), now);
      return true;
    }
    const where = locate(this.locations(), evt.cwd);
    // A login seen in the session's telemetry beats the directory and the hook URL (see ownerOf).
    const account = this.db.kvGet(`session_owner:${evt.sessionId}`) ?? where?.account ?? accountFromUrl;
    const env = where?.env ?? '';
    const set = stateForEvent(evt.event, evt.notificationType);
    // A notification that is no question (idle reminder, ...) changes nothing about the session.
    const state = set ?? 'idle';
    const turn = turnOpenFor(evt.event);
    this.db.transaction(() => {
      this.db.run('INSERT INTO hook_events (ts, session_id, account, event, cwd) VALUES (?, ?, ?, ?, ?)', now, evt.sessionId, account, evt.event, evt.cwd);
      if (set === undefined) return;
      this.db.run(
        `INSERT INTO sessions (session_id, account, env, cwd, state, started_at, last_activity_at, ended_at, turn_open)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           state = excluded.state,
           turn_open = CASE WHEN ? IS NULL THEN sessions.turn_open ELSE excluded.turn_open END,
           last_activity_at = excluded.last_activity_at,
           cwd = CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE sessions.cwd END,
           account = CASE WHEN excluded.account <> '' THEN excluded.account ELSE sessions.account END,
           env = CASE WHEN excluded.env <> '' THEN excluded.env ELSE sessions.env END,
           ended_at = excluded.ended_at`,
        evt.sessionId, account, env, evt.cwd, state, now, now, state === 'ended' ? now : null, turn ? 1 : 0, turn === undefined ? null : 1,
      );
      if (state === 'ended') this.db.run('UPDATE agents SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', now, evt.sessionId);
    });
    this.db.kvSet('last_hook_at', String(now), now);
    if (where && (evt.event === 'SessionStart' || evt.event === 'UserPromptSubmit')) this.onActive?.(where);
    return true;
  }
}

/**
 * A session's whole history moves to its owner: rows written before the owner was known (the org
 * id is not stored per row, so ended sessions cannot be re-attributed later).
 */
export function moveSessionHistory(db: Db, sessionId: string, account: string): void {
  db.transaction(() => {
    // Rollups without a session column: take the session's rolled-up requests and tool runs out of
    // the old account's hours and add them to the owner's (before the raw rows change account).
    const rolled = Number(db.kvGet('rolled_through') ?? 0);
    const reqs = db.all<{ h: number; account: string; env: string; source: string; model: string; n: number; i: number; o: number; cr: number; cc: number; cost: number }>(
      `SELECT (ts / 3600000) * 3600000 AS h, account, env, source, model, COUNT(*) AS n, SUM(COALESCE(input_tokens, 0)) AS i, SUM(COALESCE(output_tokens, 0)) AS o,
              SUM(COALESCE(cache_read_tokens, 0)) AS cr, SUM(COALESCE(cache_creation_tokens, 0)) AS cc, SUM(COALESCE(cost_usd, 0)) AS cost
         FROM api_requests WHERE session_id = ? AND account <> ? AND ts < ? AND source <> '' GROUP BY 1, 2, 3, 4, 5`,
      sessionId, account, rolled,
    );
    for (const r of reqs) {
      db.run('UPDATE rollup_source SET requests = requests - ?, input = input - ?, output = output - ?, cache_read = cache_read - ?, cache_creation = cache_creation - ?, cost_usd = cost_usd - ? WHERE hour = ? AND account = ? AND env = ? AND source = ? AND model = ?', r.n, r.i, r.o, r.cr, r.cc, r.cost, r.h, r.account, r.env, r.source, r.model);
      db.run(
        `INSERT INTO rollup_source (hour, account, env, source, model, requests, input, output, cache_read, cache_creation, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, account, env, source, model) DO UPDATE SET requests = requests + excluded.requests, input = input + excluded.input, output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read, cache_creation = cache_creation + excluded.cache_creation, cost_usd = cost_usd + excluded.cost_usd`,
        r.h, account, r.env, r.source, r.model, r.n, r.i, r.o, r.cr, r.cc, r.cost,
      );
    }
    db.run('DELETE FROM rollup_source WHERE requests <= 0');
    const tools = db.all<{ h: number; account: string; env: string; tool: string; n: number; ms: number }>(
      'SELECT (ts / 3600000) * 3600000 AS h, account, env, tool, COUNT(*) AS n, SUM(duration_ms) AS ms FROM tool_runs WHERE session_id = ? AND account <> ? AND ts < ? GROUP BY 1, 2, 3, 4',
      sessionId, account, rolled,
    );
    for (const t of tools) {
      db.run('UPDATE rollup_tools SET runs = runs - ?, ms = ms - ? WHERE hour = ? AND account = ? AND env = ? AND tool = ?', t.n, t.ms, t.h, t.account, t.env, t.tool);
      db.run(
        'INSERT INTO rollup_tools (hour, account, env, tool, runs, ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (hour, account, env, tool) DO UPDATE SET runs = runs + excluded.runs, ms = ms + excluded.ms',
        t.h, account, t.env, t.tool, t.n, t.ms,
      );
    }
    db.run('DELETE FROM rollup_tools WHERE runs <= 0');
    for (const table of ['sessions', 'usage', 'api_requests', 'tool_runs', 'hook_events']) {
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
