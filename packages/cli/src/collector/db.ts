import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as Sqlite from 'node:sqlite';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

// node:sqlite is a Node 22 builtin; loading it with require keeps bundlers and test runners from trying to resolve it.
const require = createRequire(import.meta.url);
const Database = loadSqlite();

/** Load node:sqlite without its one-time "experimental" warning cluttering CLI output. */
function loadSqlite(): typeof Sqlite.DatabaseSync {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (require('node:sqlite') as typeof Sqlite).DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
}

export const dbPath = (home: string): string => join(home, '.local', 'share', 'devhost', 'devhost.db');

type Param = string | number | bigint | null;
export type Row = Record<string, string | number | bigint | null | Uint8Array>;

/**
 * Versioned migrations (spec A10.3). Never edit an entry after release: append a new one.
 * Text keys use '' instead of NULL so they can be part of primary keys.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE usage (ts INTEGER NOT NULL, account TEXT NOT NULL, env TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL);
  CREATE INDEX usage_ts ON usage (ts);
  CREATE INDEX usage_session ON usage (session_id, ts);
  CREATE TABLE api_requests (ts INTEGER NOT NULL, account TEXT NOT NULL, env TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens REAL, output_tokens REAL, cache_read_tokens REAL, cache_creation_tokens REAL, cost_usd REAL, duration_ms REAL);
  CREATE INDEX api_requests_ts ON api_requests (ts);
  CREATE TABLE sessions (session_id TEXT PRIMARY KEY, account TEXT NOT NULL, env TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL,
    started_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, ended_at INTEGER);
  CREATE TABLE hook_events (ts INTEGER NOT NULL, session_id TEXT NOT NULL, account TEXT NOT NULL, event TEXT NOT NULL, cwd TEXT NOT NULL);
  CREATE INDEX hook_events_ts ON hook_events (ts);
  CREATE TABLE samples_system (ts INTEGER NOT NULL, cpu_pct REAL, mem_pct REAL, mem_used INTEGER, mem_total INTEGER, disk_free_pct REAL, disk_free_bytes INTEGER, load1 REAL);
  CREATE INDEX samples_system_ts ON samples_system (ts);
  CREATE TABLE samples_env (ts INTEGER NOT NULL, account TEXT NOT NULL, env TEXT NOT NULL, cpu_pct REAL, rss_bytes INTEGER, container_cpu_pct REAL, container_mem_bytes INTEGER, service_pid INTEGER);
  CREATE INDEX samples_env_ts ON samples_env (ts);
  CREATE TABLE samples_session (ts INTEGER NOT NULL, session_id TEXT NOT NULL, cpu_pct REAL, rss_bytes INTEGER);
  CREATE INDEX samples_session_ts ON samples_session (ts);
  CREATE TABLE service_events (ts INTEGER NOT NULL, account TEXT NOT NULL, env TEXT NOT NULL, kind TEXT NOT NULL, pid INTEGER);
  CREATE INDEX service_events_ts ON service_events (ts);
  CREATE TABLE env_disk (account TEXT NOT NULL, env TEXT NOT NULL, bytes INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (account, env));
  CREATE TABLE rollup_usage (hour INTEGER NOT NULL, account TEXT NOT NULL, env TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL,
    PRIMARY KEY (hour, account, env, session_id, model, kind));
  CREATE TABLE rollup_env (hour INTEGER NOT NULL, account TEXT NOT NULL, env TEXT NOT NULL, cpu_avg REAL, cpu_max REAL, rss_avg REAL, rss_max REAL, samples INTEGER NOT NULL,
    PRIMARY KEY (hour, account, env));
  CREATE TABLE alert_state (id TEXT PRIMARY KEY, active INTEGER NOT NULL, since INTEGER NOT NULL, last_notified INTEGER NOT NULL, message TEXT NOT NULL);
  `,
];

export class Db {
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    if (path !== ':memory:' && !opts.readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new Database(path, { readOnly: opts.readonly === true });
    if (!opts.readonly) {
      this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      this.migrate();
    } else {
      this.raw.exec('PRAGMA busy_timeout = 5000;');
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** Migrates on start (spec A10.3). */
  private migrate(): void {
    const current = Number((this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  get schemaVersion(): number {
    return Number((this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  }

  run(sql: string, ...params: Param[]): void {
    this.stmt(sql).run(...params);
  }
  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  kvGet(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }
  kvSet(key: string, value: string, now: number): void {
    this.run('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, now);
  }
  kvUpdatedAt(key: string): number | null {
    return this.get<{ updated_at: number }>('SELECT updated_at FROM kv WHERE key = ?', key)?.updated_at ?? null;
  }

  /** Every table as JSON text; the privacy tests grep this for prompt/code text. */
  dumpText(): string {
    const tables = this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    return tables.map((t) => JSON.stringify(this.all(`SELECT * FROM ${t.name}`), (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))).join('\n');
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * A login that just succeeded, written where the collector keeps its last check. The collector
 * only checks every `authCheckMinutes` (60), so without this the dashboard kept saying "not
 * logged in" (and the alert stayed) for up to an hour after `devhost login`. Best effort: no
 * database yet, or it is busy, and the collector's own check catches up later.
 */
export function recordLogin(home: string, account: string, now: number): void {
  const path = dbPath(home);
  if (!existsSync(path)) return;
  try {
    const db = new Db(path);
    try {
      db.kvSet(`auth:${account}`, 'ok', now);
      db.kvSet(`auth_checked:${account}`, String(now), now);
    } finally {
      db.close();
    }
  } catch {
    /* the collector's next check fills it in */
  }
}
