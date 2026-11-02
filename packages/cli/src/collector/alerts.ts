import type { Db } from './db.js';
import type { Notifier, Priority } from './notify.js';

export interface AlertThresholds {
  memoryPercent: number;
  diskFreePercent: number;
  /** account → daily cost threshold (USD) or null. */
  dailyCostUsd: Map<string, number | null>;
  /** Per environment cost alerts (USD, null = none), keyed `account/env`. */
  envCost?: Map<string, { dailyUsd: number | null; hourlyUsd: number | null }>;
}

export interface EnvCost {
  /** Estimated cost since local midnight. */
  today: number;
  /** Estimated cost over the last 60 minutes, and the session that spent most of it. */
  lastHour: number;
  topSession: { id: string; cost: number } | null;
}

export interface AlertInputs {
  memPct: number | null;
  diskFreePct: number | null;
  /** account → estimated cost since local midnight. */
  costToday: Map<string, number>;
  /** `account/env` → its cost today and over the last hour. */
  envCost?: Map<string, EnvCost>;
  /** environment → Remote Control service restarts in the last 10 minutes. */
  restarts: Map<string, number>;
  /** account → login valid? (absent = unknown). */
  auth: Map<string, boolean>;
  /** The work volume (spec A7.12), when one is configured. */
  volume?: { label: string; mountPoint: string; mounted: boolean; identityOk: boolean; doubleMount: boolean; strayDirectory: boolean; freePct: number | null; freeLimit: number } | null;
}

const MEM_WINDOW_MS = 5 * 60_000;
const AUTH_REMINDER_MS = 24 * 3_600_000;
export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** A rolling hour moves both ways: the hourly cost alert clears only below this share of its limit. */
export const HOURLY_COST_CLEAR = 0.8;

interface StoredAlert {
  active: number;
  since: number;
  last_notified: number;
  message: string;
}

/**
 * One notification per condition per state change (spec A10.5), plus a 24 h reminder
 * while a login stays broken (A10.4). State lives in SQLite so a collector restart
 * does not repeat notifications.
 */
export class AlertEngine {
  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier,
    private readonly now: () => number,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  async evaluate(thresholds: AlertThresholds, input: AlertInputs): Promise<void> {
    const now = this.now();

    // Memory: above the limit for 5 minutes in a row.
    if (input.memPct !== null) {
      const overKey = 'mem_over_since';
      if (input.memPct > thresholds.memoryPercent) {
        if (this.db.kvGet(overKey) === null) this.db.kvSet(overKey, String(now), now);
      } else if (this.db.kvGet(overKey) !== null) {
        this.db.run('DELETE FROM kv WHERE key = ?', overKey);
      }
      const since = Number(this.db.kvGet(overKey) ?? now);
      const active = this.db.kvGet(overKey) !== null && now - since >= MEM_WINDOW_MS;
      await this.set('memory', active, `Memory above ${thresholds.memoryPercent}% for 5 min (now ${input.memPct.toFixed(0)}%)`, 'Memory back below the limit', 'high');
    }

    if (input.diskFreePct !== null) {
      await this.set('disk', input.diskFreePct < thresholds.diskFreePercent, `Free disk space is ${input.diskFreePct.toFixed(1)}% (limit ${thresholds.diskFreePercent}%)`, 'Free disk space is back above the limit', 'high');
    }

    // The work volume: each condition once per state change, however often services retry meanwhile.
    const v = input.volume;
    if (v) {
      await this.set(`volume:missing:${v.label}`, !v.mounted, `Work volume ${v.label} is not mounted at ${v.mountPoint}: services on it wait until it is back`, `Work volume ${v.label} is mounted again`, 'high');
      await this.set(`volume:identity:${v.label}`, v.mounted && !v.identityOk, `The volume at ${v.mountPoint} is not the configured work volume (uuid or marker differs): services on it do not start`, `Work volume ${v.label} identity matches again`, 'high');
      await this.set(`volume:double:${v.label}`, v.doubleMount, `${v.mountPoint} 1 exists: ${v.label} is mounted a second time (a stray directory or a second volume is in its place)`, `${v.label} is mounted once again`, 'high');
      await this.set(`volume:stray:${v.label}`, v.strayDirectory, `${v.mountPoint} is a plain directory on the internal disk while the volume is away`, `${v.mountPoint} is no longer a stray directory`, 'high');
      if (v.freePct !== null) await this.set(`volume:space:${v.label}`, v.freePct < v.freeLimit, `Work volume ${v.label} has ${v.freePct.toFixed(1)}% free (limit ${v.freeLimit}%)`, `Work volume ${v.label} free space is back above the limit`, 'high');
    }

    for (const [account, limit] of thresholds.dailyCostUsd) {
      if (limit === null) continue;
      const cost = input.costToday.get(account) ?? 0;
      await this.set(`cost:${account}`, cost >= limit, `Estimated cost today for ${account} is $${cost.toFixed(2)} (limit $${limit}). This is an API-equivalent estimate, not billed money.`, `Estimated cost for ${account} is below its limit again (new day)`, 'default');
    }

    for (const [key, limits] of thresholds.envCost ?? []) {
      const c = input.envCost?.get(key) ?? { today: 0, lastHour: 0, topSession: null };
      if (limits.dailyUsd !== null) {
        await this.set(`envcost:${key}`, c.today >= limits.dailyUsd, `Estimated cost today in environment ${key} is $${c.today.toFixed(2)} (limit $${limits.dailyUsd}). An API-equivalent estimate, not billed money.`, `Estimated cost in environment ${key} is below its daily limit again (new day)`, 'default');
      }
      if (limits.hourlyUsd !== null) {
        const id = `envrate:${key}`;
        const active = c.lastHour >= limits.hourlyUsd * (this.isActive(id) ? HOURLY_COST_CLEAR : 1);
        const top = c.topSession ? ` Most of it: session ${c.topSession.id.slice(0, 8)} ($${c.topSession.cost.toFixed(2)}); check it is not stuck in a loop.` : '';
        await this.set(id, active, `Environment ${key} spent $${c.lastHour.toFixed(2)} in the last hour (limit $${limits.hourlyUsd}).${top}`, `Environment ${key} is spending below its hourly limit again`, 'high');
      }
    }

    for (const [env, count] of input.restarts) {
      await this.set(`restarts:${env}`, count > RESTART_LIMIT, `Remote Control service ${env} restarted ${count} times in 10 min`, `Remote Control service ${env} is stable again`, 'high');
    }

    for (const [account, valid] of input.auth) {
      await this.set(`auth:${account}`, !valid, `Claude login not valid: ${account}. Run: devhost login ${account}`, `Claude login for ${account} is valid again`, 'high', AUTH_REMINDER_MS);
    }
  }

  /** Current active conditions, for the dashboard. */
  active(): { id: string; message: string; since: number }[] {
    return this.db.all<{ id: string; message: string; since: number }>('SELECT id, message, since FROM alert_state WHERE active = 1 ORDER BY since');
  }

  private isActive(id: string): boolean {
    return this.db.get<{ active: number }>('SELECT active FROM alert_state WHERE id = ?', id)?.active === 1;
  }

  private async set(id: string, active: boolean, onMessage: string, offMessage: string, priority: Priority, reminderMs?: number): Promise<void> {
    const now = this.now();
    const prev = this.db.get<StoredAlert>('SELECT active, since, last_notified, message FROM alert_state WHERE id = ?', id);
    const was = prev?.active === 1;
    if (active === was) {
      if (active && reminderMs !== undefined && prev && now - prev.last_notified >= reminderMs) {
        await this.send(id, `Reminder: ${onMessage}`, priority);
        this.db.run('UPDATE alert_state SET last_notified = ? WHERE id = ?', now, id);
      }
      return;
    }
    if (!active && !prev) return; // never alerted, nothing to recover from
    const message = active ? onMessage : offMessage;
    this.db.run(
      'INSERT INTO alert_state (id, active, since, last_notified, message) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active = excluded.active, since = excluded.since, last_notified = excluded.last_notified, message = excluded.message',
      id, active ? 1 : 0, now, now, message,
    );
    await this.send(id, message, active ? priority : 'low', !active);
  }

  private async send(id: string, message: string, priority: Priority, recovered = false): Promise<void> {
    try {
      await this.notifier.send({ title: `devhost: ${id.split(':')[0]}`, message, priority, tags: [recovered ? 'white_check_mark' : 'warning'] });
    } catch (err) {
      this.log(`notification failed (${id}): ${(err as Error).message}`);
    }
  }
}
