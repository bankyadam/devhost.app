import { cpus, loadavg, totalmem, freemem, platform as osPlatform, uptime } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { DashData, DevhostConfig, UpdateData } from '@devhost/contract';
import { inWindow } from '../update.js';
import { accountsOf, environmentsOf, logsDir, rcLabel, composeProject, type Account } from '../config/accounts.js';
import type { Deps } from '../deps.js';
import { daemonState } from '../launchd.js';
import { Executor } from '../runner/executor.js';
import { AlertEngine, RESTART_WINDOW_MS, type AlertThresholds } from './alerts.js';
import { checkAuth } from './auth.js';
import type { Db } from './db.js';
import { envLocations, type EnvLocation } from './hooks.js';
import { Ingestor } from './ingest.js';
import type { Notifier } from './notify.js';
import { retain, rollup } from './rollup.js';
import { volumeStatus, workVolumeOf } from '../storage/volume.js';
import { rotateLogs } from './logs.js';
import {
  cpuPercent, cpuTimes, memoryFromVmStat, parseMemorySysctl, parseDockerPs, parseDockerStats, parseDu, parseLsofCwd, parsePs, parseVmStat,
  subtree, sumProcs, type Proc,
} from './samplers.js';

/** A session quiet this long with no `claude` in its directory has ended (see sampleSessions). */
const SESSION_GONE_MS = 10 * 60_000;
import { createCollectorServer, listen } from './server.js';

export interface OsProbe {
  platform: string;
  cpus: () => { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[];
  loadavg: () => number[];
  totalmem: () => number;
  freemem: () => number;
  uptime: () => number;
  /** Free and total bytes of the root volume. */
  disk: () => Promise<{ freeBytes: number; totalBytes: number }>;
}

export const realOs: OsProbe = {
  platform: osPlatform(),
  cpus,
  loadavg,
  totalmem,
  freemem,
  uptime,
  disk: async () => {
    const s = await statfs('/');
    return { freeBytes: Number(s.bavail) * s.bsize, totalBytes: Number(s.blocks) * s.bsize };
  },
};

export interface CollectorOptions {
  db: Db;
  /** Latest config; re-read by the caller when the file changes. */
  config: () => DevhostConfig;
  deps: Pick<Deps, 'home' | 'runner' | 'user' | 'brewPrefix'>;
  notifier: Notifier;
  now?: () => number;
  os?: OsProbe;
  log?: (msg: string) => void;
  /** How to run this devhost (for `devhost update`): node, the CLI script and `--config <path>`. */
  selfCommand?: string[];
}

/** What the dashboard shows of updates (kv `update`). */
type UpdateState = NonNullable<DashData['updates']>;

const midnight = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The collector's brain: samplers, auth check, alerts, maintenance. Timers live in `start()`. */
export class Collector {
  readonly db: Db;
  private readonly opts: CollectorOptions;
  private readonly now: () => number;
  private readonly os: OsProbe;
  private readonly exec: Executor;
  readonly ingest: Ingestor;
  readonly alerts: AlertEngine;
  private prevCpu: { idle: number; total: number } | null = null;
  private docker = new Map<string, { cpu: number; memBytes: number }>();
  private lastPid = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private server: Server | null = null;

  constructor(opts: CollectorOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.os = opts.os ?? realOs;
    this.exec = new Executor(
      opts.deps.runner,
      { step: () => undefined, log: () => undefined },
      { dryRun: false, verbose: false, interactiveSudo: false, now: () => new Date(this.now()) },
    );
    this.ingest = new Ingestor(opts.db, this.now, () => this.locations());
    this.alerts = new AlertEngine(opts.db, opts.notifier, this.now, opts.log);
  }

  private get config(): DevhostConfig {
    return this.opts.config();
  }
  private log(msg: string): void {
    this.opts.log?.(msg);
  }
  private locations(): EnvLocation[] {
    return envLocations(this.config, this.opts.deps.home);
  }
  private async safe(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log(`${name} failed: ${(err as Error).message}`);
    }
  }

  // ---- sampling (every sampleIntervalSeconds) ----

  async sampleTick(): Promise<void> {
    await this.safe('system sample', () => this.sampleSystem());
    await this.safe('process sample', () => this.sampleProcesses());
    await this.safe('volume sample', () => this.sampleVolume());
    await this.safe('alerts', () => this.evaluateAlerts());
  }

  private async sampleSystem(): Promise<void> {
    const now = this.now();
    const times = cpuTimes(this.os.cpus());
    const cpu = cpuPercent(this.prevCpu, times);
    this.prevCpu = times;

    let memTotal = this.os.totalmem();
    let memUsed = memTotal - this.os.freemem();
    if (this.os.platform === 'darwin') {
      const vm = await this.exec.query('vm_stat', []);
      const total = await this.exec.query('sysctl', ['-n', 'hw.memsize']);
      if (vm.code === 0 && total.code === 0 && Number(total.stdout) > 0) {
        memTotal = Number(total.stdout);
        memUsed = memoryFromVmStat(parseVmStat(vm.stdout), memTotal).used;
      }
    }
    // Swap in use and the kernel's memory pressure level (1 normal, 2 warning, 4 critical).
    let swapUsed: number | null = null;
    let pressure: number | null = null;
    if (this.os.platform === 'darwin') {
      const r = await this.exec.query('sysctl', ['vm.swapusage', 'kern.memorystatus_vm_pressure_level']);
      if (r.code === 0) ({ swapUsed, pressure } = parseMemorySysctl(r.stdout));
    }
    const disk = await this.os.disk();
    this.db.run(
      'INSERT INTO samples_system (ts, cpu_pct, mem_pct, mem_used, mem_total, disk_free_pct, disk_free_bytes, load1, swap_used, mem_pressure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now, cpu, memTotal > 0 ? (memUsed / memTotal) * 100 : null, Math.round(memUsed), Math.round(memTotal),
      disk.totalBytes > 0 ? (disk.freeBytes / disk.totalBytes) * 100 : null, Math.round(disk.freeBytes), this.os.loadavg()[0] ?? null, swapUsed, pressure,
    );
    this.db.kvSet('uptime_s', String(Math.round(this.os.uptime())), now);
  }

  /** The work volume every sample (spec A10.1): its state for the dashboard and the alerts. */
  private async sampleVolume(): Promise<void> {
    const v = workVolumeOf(this.config);
    if (!v) {
      this.db.run("DELETE FROM kv WHERE key = 'volume'");
      return;
    }
    const s = await volumeStatus(this.exec, v);
    const freePct = s.totalBytes && s.freeBytes !== null ? (s.freeBytes / s.totalBytes) * 100 : null;
    this.db.kvSet('volume', JSON.stringify({ ...s, root: v.root, freePct, freeLimit: v.alerts?.freePercent ?? 15, encryptedInConfig: v.encrypted === true }), this.now());
  }

  private async sampleProcesses(): Promise<void> {
    const now = this.now();
    const ps = await this.exec.query('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command=']);
    if (ps.code !== 0) return;
    const procs = parsePs(ps.stdout);

    for (const e of environmentsOf(this.config)) {
      if (e.remoteControl?.enabled === false) continue;
      const label = rcLabel(e.account, e.name);
      const key = `${e.account}/${e.name}`;
      const state = await daemonState(this.exec, label);
      const pid = state.running ? state.pid : null;
      const known = this.lastPid.get(key);
      if (pid !== null && known !== undefined && pid !== known) {
        this.db.run('INSERT INTO service_events (ts, account, env, kind, pid) VALUES (?, ?, ?, ?, ?)', now, e.account, e.name, 'restart', pid);
      }
      if (pid !== null) this.lastPid.set(key, pid);
      const sum = pid !== null ? sumProcs(subtree(procs, pid)) : { cpu: 0, rssBytes: 0 };
      const container = this.docker.get(composeProject(e.name));
      this.db.run(
        'INSERT INTO samples_env (ts, account, env, cpu_pct, rss_bytes, container_cpu_pct, container_mem_bytes, service_pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        now, e.account, e.name, sum.cpu, sum.rssBytes, container?.cpu ?? null, container ? Math.round(container.memBytes) : null, pid,
      );
    }
    await this.sampleSessions(procs, now);
    this.sampleAgents(now);
  }

  /**
   * How many agents work right now: sessions running a turn (between a prompt and its Stop) plus
   * subagents that started and have not stopped, per account and in total (account '').
   */
  sampleAgents(now: number): void {
    const rows = this.db.all<{ account: string; sessions: number; subagents: number }>(
      `SELECT s.account AS account,
              SUM(CASE WHEN s.state = 'running' THEN 1 ELSE 0 END) AS sessions,
              (SELECT COUNT(*) FROM agents a JOIN sessions x ON x.session_id = a.session_id WHERE a.ended_at IS NULL AND x.state <> 'ended' AND x.account = s.account) AS subagents
         FROM sessions s WHERE s.state <> 'ended' GROUP BY s.account`,
    );
    const counts = new Map(accountsOf(this.config).map((a) => [a.name, { sessions: 0, subagents: 0 }]));
    for (const r of rows) counts.set(r.account, { sessions: Number(r.sessions), subagents: Number(r.subagents) });
    let sessions = 0;
    let subagents = 0;
    this.db.transaction(() => {
      for (const [account, c] of counts) {
        this.db.run('INSERT INTO samples_agents (ts, account, sessions, subagents) VALUES (?, ?, ?, ?)', now, account, c.sessions, c.subagents);
        sessions += c.sessions;
        subagents += c.subagents;
      }
      this.db.run("INSERT INTO samples_agents (ts, account, sessions, subagents) VALUES (?, '', ?, ?)", now, sessions, subagents);
    });
  }

  /**
   * Best effort (spec A10.7): match `claude` processes to sessions by working directory. A session
   * no `claude` works in any more, quiet for SESSION_GONE_MS, ended without a SessionEnd hook (its
   * process went down with a service restart, or was stopped): it is marked ended, so the
   * dashboard and the plugins do not take it for alive.
   */
  private async sampleSessions(procs: Proc[], now: number): Promise<void> {
    const open = this.db.all<{ session_id: string; cwd: string; last_activity_at: number }>("SELECT session_id, cwd, last_activity_at FROM sessions WHERE state <> 'ended' AND cwd <> ''");
    if (open.length === 0 || procs.length === 0) return; // no ps output: nothing is known
    const candidates = procs.filter((p) => /(^|\/)claude(\s|$)/.test(p.command));
    let cwds = new Map<number, string>();
    if (candidates.length > 0) {
      const lsof = await this.exec.query('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', candidates.map((p) => p.pid).join(',')]);
      cwds = parseLsofCwd(lsof.stdout);
      if (cwds.size === 0) return; // lsof said nothing: do not conclude anything ended
    }
    for (const s of open) {
      const mine = candidates.filter((p) => {
        const cwd = cwds.get(p.pid);
        return cwd !== undefined && (cwd === s.cwd || cwd.startsWith(`${s.cwd}/`));
      });
      if (mine.length === 0) {
        if (now - s.last_activity_at > SESSION_GONE_MS) {
          this.db.run("UPDATE sessions SET state = 'ended', ended_at = ? WHERE session_id = ?", now, s.session_id);
          this.db.run('UPDATE agents SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', now, s.session_id);
        }
        continue;
      }
      if (s.last_activity_at <= now - 24 * 3_600_000) continue;
      const sum = sumProcs(mine.flatMap((p) => subtree(procs, p.pid)));
      this.db.run('INSERT INTO samples_session (ts, session_id, cpu_pct, rss_bytes) VALUES (?, ?, ?, ?)', now, s.session_id, sum.cpu, sum.rssBytes);
    }
  }

  // ---- slower samplers ----

  async dockerTick(): Promise<void> {
    await this.safe('docker sample', async () => {
      const now = this.now();
      const info = await this.exec.query('docker', ['info', '--format', '{{.ServerVersion}}']);
      this.db.kvSet('docker', info.code === 0 ? 'up' : 'down', now);
      if (info.code !== 0) {
        this.docker.clear();
        return;
      }
      const stats = parseDockerStats((await this.exec.query('docker', ['stats', '--no-stream', '--format', '{{json .}}'])).stdout);
      const projects = parseDockerPs((await this.exec.query('docker', ['ps', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}'])).stdout);
      const next = new Map<string, { cpu: number; memBytes: number }>();
      for (const s of stats) {
        const project = projects.get(s.name);
        if (!project) continue;
        const cur = next.get(project) ?? { cpu: 0, memBytes: 0 };
        next.set(project, { cpu: cur.cpu + s.cpu, memBytes: cur.memBytes + s.memBytes });
      }
      this.docker = next;
    });
  }

  async tailscaleTick(): Promise<void> {
    await this.safe('tailscale sample', async () => {
      const r = await this.exec.query('tailscale', ['status', '--json']);
      let value = 'unavailable';
      if (r.code === 0) {
        try {
          const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
          value = JSON.stringify({ state: j.BackendState ?? 'unknown', dnsName: j.Self?.DNSName?.replace(/\.$/, '') ?? null });
        } catch {
          /* keep unavailable */
        }
      }
      this.db.kvSet('tailscale', value, this.now());
    });
  }

  /** Daily: size per environment (worktrees, node_modules). */
  async diskUsageTick(): Promise<void> {
    await this.safe('disk usage', async () => {
      for (const l of this.locations()) {
        const r = await this.exec.query('du', ['-sk', l.dir]);
        const bytes = r.code === 0 ? parseDu(r.stdout) : null;
        if (bytes !== null) this.db.run('INSERT OR REPLACE INTO env_disk (account, env, bytes, ts) VALUES (?, ?, ?, ?)', l.account, l.env, bytes, this.now());
      }
    });
  }

  async authTick(): Promise<void> {
    await this.safe('auth check', async () => {
      await checkAuth(this.db, this.exec, this.opts.deps, this.config, this.now());
    });
  }

  /** Runs `devhost update <args> --json` and returns its result event's data (null when it gave none). */
  private async runSelf(args: string[]): Promise<{ ok: boolean; data: UpdateData | null; message: string }> {
    const [cmd, ...pre] = this.opts.selfCommand ?? [process.execPath, '--disable-warning=ExperimentalWarning', process.argv[1]!];
    const r = await this.exec.query(cmd!, [...pre, 'update', ...args, '--json']);
    const last = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{"type":"result"'));
    if (!last) return { ok: false, data: null, message: r.stderr.trim().split('\n').pop() || `devhost update exited ${r.code}` };
    const e = JSON.parse(last) as { ok: boolean; data: UpdateData | null; errors?: { message: string }[] };
    return { ok: e.ok, data: e.data, message: e.errors?.map((x) => x.message).join('; ') ?? '' };
  }

  /**
   * Hourly: the daily update check, and with claude.update auto, inside claude.updateWindow, the
   * Claude Code update itself. `devhost update` waits while a session is in the middle of a turn,
   * so this tries again the next hour. A failed update is not retried until the next day's check.
   */
  async updateTick(): Promise<void> {
    await this.safe('update', async () => {
      const mode = this.config.claude?.update ?? 'auto';
      if (mode === 'off') return;
      const now = this.now();
      const old = JSON.parse(this.db.kvGet('update') ?? 'null') as UpdateState | null;
      let state = old;
      if (!state || now - state.checkedAt > 20 * 3_600_000) {
        const r = await this.runSelf(['--check']);
        if (!r.data) {
          this.log(`update check failed: ${r.message}`);
          return;
        }
        const c = r.data.claude;
        state = { checkedAt: now, claude: { installed: c.installed, latest: c.latest, outdated: c.outdated, ...(c.shadowed?.length ? { shadowed: c.shadowed } : {}) }, packages: r.data.packages.length, ...(old?.lastUpdate ? { lastUpdate: old.lastUpdate } : {}) };
      }
      state.mode = mode;
      delete state.waiting;
      const latest = state.claude.latest;
      if (state.claude.outdated && latest) {
        const window = this.config.claude?.updateWindow ?? '02:00-06:00';
        const failedToday = state.lastUpdate && !state.lastUpdate.ok && now - state.lastUpdate.at < 20 * 3_600_000;
        if (mode === 'notify') {
          if (this.db.kvGet('update_notified') !== latest) {
            this.db.kvSet('update_notified', latest, now);
            await this.opts.notifier.send({ title: 'devhost: Claude Code update', message: `Claude Code ${latest} is available (${state.claude.installed} installed). Update from the app or with \`devhost update\`.`, tags: ['arrow_up'] });
          }
        } else if (failedToday) {
          state.waiting = 'the last attempt failed; trying again after the next daily check';
        } else if (!inWindow(window, new Date(now))) {
          state.waiting = `updates run between ${window.replace('-', ' and ')}`;
        } else {
          const r = await this.runSelf([]);
          if (r.data?.busy?.length) {
            state.waiting = `${r.data.busy.length} session(s) in the middle of a turn`;
          } else if (r.data?.claude.updated) {
            const re = r.data.reattached ?? [];
            const message = `Claude Code ${state.claude.installed} → ${r.data.claude.installed}; ${r.data.restarted?.length ?? 0} service(s) restarted${re.length ? `, ${re.filter((x) => x.ok).length} of ${re.length} session(s) reattached` : ''}.`;
            state.claude = { ...state.claude, installed: r.data.claude.installed, outdated: false };
            state.lastUpdate = { at: now, ok: r.ok, message: r.ok ? message : `${message} ${r.message}` };
            await this.opts.notifier.send({ title: 'devhost: Claude Code updated', message: state.lastUpdate.message, tags: [r.ok ? 'white_check_mark' : 'warning'] });
          } else {
            state.lastUpdate = { at: now, ok: false, message: r.message || 'Claude Code did not change' };
            await this.opts.notifier.send({ title: 'devhost: Claude Code update failed', message: state.lastUpdate.message, priority: 'high', tags: ['warning'] });
          }
        }
      }
      this.db.kvSet('update', JSON.stringify(state), now);
    });
  }

  async maintenanceTick(): Promise<void> {
    await this.safe('rollup', async () => {
      const now = this.now();
      rollup(this.db, now);
      const r = this.config.collector?.retention;
      retain(this.db, now, { rawDays: r?.rawDays ?? 7, rollupDays: r?.rollupDays ?? 365 });
    });
    await this.safe('log rotation', async () => {
      const at = (name: string): number | null => {
        const v = this.db.kvGet(`log_rotated:${name}`);
        return v === null ? null : Number(v);
      };
      await rotateLogs(logsDir(this.opts.deps.home), this.now(), this.config.collector?.retention?.logDays ?? 7, at, (name, t) => this.db.kvSet(`log_rotated:${name}`, String(t), t));
    });
  }

  private async evaluateAlerts(): Promise<void> {
    const now = this.now();
    const cfg = this.config;
    const sys = this.db.get<{ mem_pct: number | null; disk_free_pct: number | null }>('SELECT mem_pct, disk_free_pct FROM samples_system ORDER BY ts DESC LIMIT 1');
    const thresholds: AlertThresholds = {
      memoryPercent: cfg.collector?.alerts?.memoryPercent ?? 90,
      diskFreePercent: cfg.collector?.alerts?.diskFreePercent ?? 15,
      dailyCostUsd: new Map(accountsOf(cfg).map((a: Account) => [a.name, a.alerts?.dailyCostUsd ?? null])),
    };
    const costToday = new Map<string, number>();
    for (const r of this.db.all<{ account: string; cost: number }>("SELECT account, SUM(value) AS cost FROM usage WHERE kind = 'cost' AND ts >= ? GROUP BY account", midnight(now))) {
      costToday.set(r.account, r.cost);
    }
    const restarts = new Map<string, number>();
    for (const e of environmentsOf(cfg)) {
      const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM service_events WHERE kind = 'restart' AND account = ? AND env = ? AND ts >= ?", e.account, e.name, now - RESTART_WINDOW_MS)?.n ?? 0;
      restarts.set(e.name, n);
    }
    const auth = new Map<string, boolean>();
    for (const a of accountsOf(cfg)) {
      const v = this.db.kvGet(`auth:${a.name}`);
      if (v !== null) auth.set(a.name, v === 'ok');
    }
    const vol = workVolumeOf(cfg) ? (JSON.parse(this.db.kvGet('volume') ?? 'null') as null | { label: string; mountPoint: string; mounted: boolean; uuidMatch: boolean; markerMatch: boolean; doubleMount: boolean; strayDirectory: boolean; freePct: number | null; freeLimit: number }) : null;
    const volume = vol ? { label: vol.label, mountPoint: vol.mountPoint, mounted: vol.mounted, identityOk: vol.uuidMatch && vol.markerMatch, doubleMount: vol.doubleMount, strayDirectory: vol.strayDirectory, freePct: vol.freePct, freeLimit: vol.freeLimit } : null;
    await this.alerts.evaluate(thresholds, { memPct: sys?.mem_pct ?? null, diskFreePct: sys?.disk_free_pct ?? null, costToday, restarts, auth, volume });
  }

  // ---- lifecycle ----

  /** Listen on 127.0.0.1 and start all timers. */
  async start(): Promise<void> {
    const port = this.config.collector?.port ?? 4318;
    this.server = createCollectorServer(this.ingest, (m) => this.log(m));
    await listen(this.server, port);
    this.log(`collector listening on 127.0.0.1:${port}`);

    const every = (ms: number, fn: () => Promise<void>): void => {
      this.timers.push(setInterval(() => void fn(), ms));
    };
    const interval = (this.config.collector?.sampleIntervalSeconds ?? 5) * 1000;
    every(interval, () => this.sampleTick());
    every(15_000, () => this.dockerTick());
    every(60_000, () => this.tailscaleTick());
    every(Math.max(1, this.config.collector?.authCheckMinutes ?? 60) * 60_000, () => this.authTick());
    every(10 * 60_000, () => this.maintenanceTick());
    every(24 * 3_600_000, () => this.diskUsageTick());
    every(3_600_000, () => this.updateTick());
    // First readings shortly after start so the dashboard is not empty.
    for (const [delay, fn] of [[500, () => this.sampleTick()], [1500, () => this.dockerTick()], [2000, () => this.tailscaleTick()], [10_000, () => this.authTick()], [30_000, () => this.diskUsageTick()], [60_000, () => this.maintenanceTick()], [120_000, () => this.updateTick()]] as const) {
      const t = setTimeout(() => void fn(), delay);
      this.timers.push(t);
    }
  }

  async stop(): Promise<void> {
    this.timers.forEach((t) => clearInterval(t));
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
