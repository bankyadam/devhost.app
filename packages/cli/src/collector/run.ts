import { cpus, loadavg, totalmem, freemem, hostname, platform as osPlatform, uptime } from 'node:os';
import { stat, statfs } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { DashData, DevhostConfig, UpdateData } from '@devhost/contract';
import { inWindow } from '../update.js';
import { accountsOf, effectiveClaudeDir, environmentsOf, logsDir, rcLabel, composeProject, type Account } from '../config/accounts.js';
import { remoteSessionFrom } from '../reattach.js';
import { tailscaleStatus, toSample } from '../tailscale-status.js';
import type { Deps } from '../deps.js';
import { daemonState } from '../launchd.js';
import { sleepEnv, sleepState, wakeEnv } from '../sleep.js';
import { handoffAt, lastMainRequest, writeHandoff, type HandoffSession } from '../handoff.js';
import { Executor } from '../runner/executor.js';
import { AlertEngine, RESTART_WINDOW_MS, type AlertThresholds } from './alerts.js';
import { checkAuth } from './auth.js';
import { dbPath, type Db } from './db.js';
import { buildLive, buildRange, type RangeParts } from './query.js';
import { Sources, TIMEOUT } from './sources.js';
import { TitleCache } from './titles.js';
import { envLocations, type EnvLocation } from './hooks.js';
import { Ingestor } from './ingest.js';
import type { Notifier } from './notify.js';
import { retain, rollup } from './rollup.js';
import { volumeStatus, workVolumeOf } from '../storage/volume.js';
import { rotateLogs } from './logs.js';
import {
  cpuPercent, cpuTimes, memoryFromVmStat, parseMemorySysctl, parseDockerPs, parseDockerStats, parseDu, parsePs, parseVmStat,
  subtree, sumProcs, type Proc,
} from './samplers.js';

/** A Remote Control session quiet this long whose process is gone has ended (see sampleSessions). */
const SESSION_GONE_MS = 10 * 60_000;
/** Any other session without a hook this long has ended (its SessionEnd never came). */
const SESSION_STALE_MS = 24 * 3_600_000;
/** How often the slower parts run: the services' pids from launchd, the work volume, the snapshot's range parts. */
const SERVICE_PIDS_MS = 60_000;
const VOLUME_MS = 60_000;
const RANGE_MS = 60_000;
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
  /** Remote Control session processes whose claude.ai session is recorded already. */
  private bridged = new Set<number>();
  private servicePids = new Map<string, { pid: number | null; at: number }>();
  private lastVolumeAt = 0;
  private range: { at: number; parts: RangeParts } | null = null;
  private procs: Proc[] = [];
  private self: { cpu: NodeJS.CpuUsage; at: number } | null = null;
  private readonly titles = new TitleCache();
  readonly sources: Sources;
  private timers: NodeJS.Timeout[] = [];
  private server: Server | null = null;

  constructor(opts: CollectorOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.os = opts.os ?? realOs;
    this.exec = new Executor(
      opts.deps.runner,
      { step: () => undefined, log: () => undefined },
      { dryRun: false, verbose: false, interactiveSudo: false, now: () => new Date(this.now()) },
    );
    this.ingest = new Ingestor(opts.db, this.now, () => this.locations(), (where) => void this.wake(where));
    this.alerts = new AlertEngine(opts.db, opts.notifier, this.now, opts.log);
    this.sources = new Sources((m) => this.log(m));
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

  /**
   * Every sampleIntervalSeconds: system, processes (one `ps`), the work volume (every minute),
   * alerts, then the precomputed dashboard snapshot and the collector's own load.
   */
  async sampleTick(): Promise<void> {
    await this.sources.run('sample', async () => {
      await this.safe('system sample', () => this.sampleSystem());
      await this.safe('process sample', () => this.sampleProcesses());
      if (this.now() - this.lastVolumeAt >= VOLUME_MS) {
        this.lastVolumeAt = this.now();
        await this.safe('volume sample', () => this.sampleVolume());
      }
      await this.safe('alerts', () => this.evaluateAlerts());
      await this.safe('snapshot', () => this.writeSnapshot());
      this.safeSync('self sample', () => this.sampleSelf());
    });
  }

  private safeSync(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`${name} failed: ${(err as Error).message}`);
    }
  }

  /**
   * The dashboard's state now (kv `snapshot`), so `dash` and the plugins only read it: the live
   * parts every tick, the 24 h range parts every minute, session titles from transcripts that changed.
   */
  async writeSnapshot(): Promise<void> {
    const now = this.now();
    const path = dbPath(this.opts.deps.home);
    const size = await stat(path).then((s) => s.size, () => null);
    const wal = await stat(`${path}-wal`).then((s) => s.size, () => 0);
    const live = buildLive(this.db, this.config, { range: '24h', home: this.opts.deps.home }, now, hostname(), size === null ? null : size + wal);
    if (!this.range || now - this.range.at >= RANGE_MS) this.range = { at: now, parts: buildRange(this.db, { range: '24h' }, now) };
    const dirs = [...new Set(accountsOf(this.config).map((a) => effectiveClaudeDir(a, this.opts.deps.home)))];
    const cwds = new Map(this.db.all<{ session_id: string; cwd: string }>("SELECT session_id, cwd FROM sessions WHERE state <> 'ended' OR ended_at >= ?", now - 2 * 86_400_000).map((r) => [r.session_id, r.cwd]));
    const sessions = [];
    for (const s of live.sessions) {
      const t = await this.titles.get(dirs, cwds.get(s.id) ?? '', s.id);
      sessions.push(t ? { ...s, title: t.title, ...(t.fromPrompt ? { titleFromPrompt: true } : {}) } : s);
    }
    this.titles.retain(new Set(live.sessions.map((s) => s.id)));
    this.db.kvSet('snapshot', JSON.stringify({ ...live, sessions, ...this.range.parts }), now);
  }

  /** The collector's own CPU, memory, child processes (overlapping ones too) and skipped ticks. */
  sampleSelf(): void {
    const now = this.now();
    const cpu = process.cpuUsage();
    const pct = this.self ? ((cpu.user - this.self.cpu.user + cpu.system - this.self.cpu.system) / 1000 / Math.max(1, now - this.self.at)) * 100 : 0;
    this.self = { cpu, at: now };
    const children = this.procs.filter((p) => p.ppid === process.pid && !/^(\/bin\/)?ps -axo/.test(p.command));
    const names = children.map((p) => p.command.split(' ')[0]!.split('/').pop()!);
    const overlaps = names.length - new Set(names).size;
    const skipped = [...this.sources.skipped.values()].reduce((a, b) => a + b, 0);
    this.db.run('INSERT INTO samples_collector (ts, cpu_pct, rss_bytes, children, overlaps, skipped) VALUES (?, ?, ?, ?, ?, ?)', now, pct, process.memoryUsage().rss, children.length, overlaps, skipped);
  }

  private async sampleSystem(): Promise<void> {
    const now = this.now();
    const times = cpuTimes(this.os.cpus());
    const cpu = cpuPercent(this.prevCpu, times);
    this.prevCpu = times;

    const memTotal = this.os.totalmem();
    let memUsed = memTotal - this.os.freemem();
    if (this.os.platform === 'darwin') {
      // os.totalmem() is hw.memsize; vm_stat gives what Activity Monitor calls used.
      const vm = await this.exec.query('vm_stat', [], { timeoutMs: TIMEOUT.fast });
      if (vm.code === 0) memUsed = memoryFromVmStat(parseVmStat(vm.stdout), memTotal).used;
    }
    // Swap in use and the kernel's memory pressure level (1 normal, 2 warning, 4 critical).
    let swapUsed: number | null = null;
    let pressure: number | null = null;
    if (this.os.platform === 'darwin') {
      const r = await this.exec.query('sysctl', ['vm.swapusage', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: TIMEOUT.fast });
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
    const ps = await this.exec.query('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], { timeoutMs: TIMEOUT.ps });
    if (ps.code !== 0) return;
    const procs = parsePs(ps.stdout);
    this.procs = procs;

    for (const e of environmentsOf(this.config)) {
      if (e.remoteControl?.enabled === false) continue;
      const label = rcLabel(e.account, e.name);
      const key = `${e.account}/${e.name}`;
      const pid = await this.servicePid(label, procs, now);
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
   * A Remote Control service's pid: from launchd once a minute, in between the last one while `ps`
   * still shows it as a `claude remote-control` process (a restart changes it, so launchd is asked again).
   */
  private async servicePid(label: string, procs: Proc[], now: number): Promise<number | null> {
    const cached = this.servicePids.get(label);
    const alive = (pid: number | null): boolean => pid !== null && procs.some((p) => p.pid === pid && /remote-control/.test(p.command));
    if (cached && now - cached.at < SERVICE_PIDS_MS && (cached.pid === null || alive(cached.pid))) return cached.pid;
    const state = await daemonState(this.exec, label, TIMEOUT.fast);
    const pid = state.running ? state.pid : null;
    this.servicePids.set(label, { pid, at: now });
    return pid;
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
   * Per session, from the process tree only (spec A10.7; never lsof): a Remote Control session in its
   * worktree (`bridge-cse_<id>`) is the service's child started with `--session-id cse_<id>`; its
   * subtree's CPU and memory are sampled. Gone and quiet for SESSION_GONE_MS: ended (its process
   * went down with a service restart, or was stopped). Other sessions cannot be told apart by
   * process: they end with their SessionEnd hook, or after SESSION_STALE_MS without hooks. A
   * session the service runs in the environment's own folder is told by its claude.ai session,
   * which Claude Code keeps in `<config dir>/sessions/<pid>.json` while it runs (recordBridged).
   */
  private async sampleSessions(procs: Proc[], now: number): Promise<void> {
    if (procs.length === 0) return; // no ps output: nothing is known
    const byKey = new Map<string, Proc>();
    for (const p of procs) {
      const key = /--session-id (cse_[A-Za-z0-9]+)/.exec(p.command)?.[1];
      if (key && !/remote-control/.test(p.command)) byKey.set(key, p);
    }
    await this.recordBridged([...byKey.values()]);
    const open = this.db.all<{ session_id: string; cwd: string; last_activity_at: number; remote_session: string | null }>(
      "SELECT session_id, cwd, last_activity_at, remote_session FROM sessions WHERE state <> 'ended'",
    );
    const end = (id: string): void => {
      this.db.run("UPDATE sessions SET state = 'ended', ended_at = ? WHERE session_id = ?", now, id);
      this.db.run('UPDATE agents SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', now, id);
    };
    for (const s of open) {
      const remote = remoteSessionFrom(s.cwd, s.remote_session);
      if (!remote) {
        if (now - s.last_activity_at > SESSION_STALE_MS) end(s.session_id);
        continue;
      }
      const proc = byKey.get(remote.key);
      if (!proc) {
        if (now - s.last_activity_at > SESSION_GONE_MS) end(s.session_id);
        continue;
      }
      const sum = sumProcs(subtree(procs, proc.pid));
      this.db.run('INSERT INTO samples_session (ts, session_id, cpu_pct, rss_bytes) VALUES (?, ?, ?, ?)', now, s.session_id, sum.cpu, sum.rssBytes);
    }
  }

  /** Records the claude.ai session of each Remote Control session process, once per process. */
  private async recordBridged(procs: Proc[]): Promise<void> {
    const live = new Set(procs.map((p) => p.pid));
    for (const pid of this.bridged) if (!live.has(pid)) this.bridged.delete(pid);
    const dirs = [...new Set(accountsOf(this.config).map((a) => effectiveClaudeDir(a, this.opts.deps.home)))];
    for (const p of procs) {
      if (this.bridged.has(p.pid)) continue;
      for (const dir of dirs) {
        const text = await this.exec.readText(`${dir}/sessions/${p.pid}.json`);
        if (text === null) continue;
        try {
          const { sessionId, bridgeSessionId } = JSON.parse(text) as { sessionId?: unknown; bridgeSessionId?: unknown };
          if (typeof sessionId !== 'string' || typeof bridgeSessionId !== 'string' || !/^session_[A-Za-z0-9]+$/.test(bridgeSessionId)) break;
          // The session row comes with its first hook or OTel event: until then, try again.
          if (!this.db.get('SELECT 1 FROM sessions WHERE session_id = ?', sessionId)) break;
          this.db.run('UPDATE sessions SET remote_session = ? WHERE session_id = ?', bridgeSessionId, sessionId);
          this.bridged.add(p.pid);
        } catch {
          /* written while we read: next tick */
        }
        break;
      }
    }
  }

  // ---- slower samplers ----

  async dockerTick(): Promise<void> {
    await this.sources.run('docker', async () => {
      const now = this.now();
      const info = await this.exec.query('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: TIMEOUT.docker });
      this.db.kvSet('docker', info.code === 0 ? 'up' : 'down', now);
      if (info.code !== 0) {
        this.docker.clear();
        return;
      }
      const stats = parseDockerStats((await this.exec.query('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeoutMs: TIMEOUT.docker })).stdout);
      const projects = parseDockerPs((await this.exec.query('docker', ['ps', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}'], { timeoutMs: TIMEOUT.docker })).stdout);
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

  // ---- sleeping environments (A7.9) ----

  /** When the collector started: an environment counts as used from then on, so a restart does not put everything to sleep. */
  private readonly startedAt: number;
  private waking = new Set<string>();

  /** A session started or got a prompt in an environment: start the services it had when it fell asleep. */
  async wake(where: EnvLocation): Promise<void> {
    if (this.waking.has(where.env) || !(await sleepState(this.opts.deps.home, where.env))) return;
    this.waking.add(where.env);
    try {
      const state = await wakeEnv(this.exec, this.opts.deps.home, where.env, where.dir);
      if (state) {
        this.db.kvSet(`awake:${where.env}`, String(this.now()), this.now());
        this.log(`${where.env} woke up for a session: started ${state.services.join(', ')}`);
      }
    } catch (err) {
      this.log(`waking ${where.env} failed: ${(err as Error).message}`);
    } finally {
      this.waking.delete(where.env);
    }
  }

  /**
   * Every minute: an environment whose compose services run and that had no session activity for
   * docker.idleSleepMinutes falls asleep. A session in the middle of a turn keeps it awake however
   * long the turn takes.
   */
  async sleepTick(): Promise<void> {
    const minutes = this.config.docker?.idleSleepMinutes ?? 60;
    if (minutes <= 0) return;
    await this.sources.run('sleep', async () => {
      const now = this.now();
      const envs = new Map(environmentsOf(this.config).map((e) => [e.name, e]));
      for (const l of this.locations()) {
        if (envs.get(l.env)?.compose === 'off' || !this.docker.has(composeProject(l.env))) continue;
        if (await sleepState(this.opts.deps.home, l.env)) continue;
        const busy = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE env = ? AND state = 'running'", l.env)?.n ?? 0;
        if (busy > 0) continue;
        const last = Math.max(
          this.db.get<{ t: number | null }>('SELECT MAX(last_activity_at) AS t FROM sessions WHERE env = ?', l.env)?.t ?? 0,
          Number(this.db.kvGet(`awake:${l.env}`) ?? 0),
          this.startedAt,
        );
        if (now - last < minutes * 60_000) continue;
        await this.safe(`sleep ${l.env}`, async () => {
          const state = await sleepEnv(this.exec, this.opts.deps.home, l.env, l.dir, now);
          if (state) this.log(`${l.env} fell asleep after ${minutes} min without a session: stopped ${state.services.join(', ')}`);
        });
      }
    });
  }

  // ---- handoff notes (A10.10) ----

  /**
   * Every minute: a session idle or waiting for claude.handoff.idleMinutes (default 55, just under
   * the prompt cache's hour) whose context is large gets a handoff note, once per quiet spell. Only
   * sessions that went quiet in the last 15 minutes past the mark: a collector that was off does not
   * write notes for every old session at once. One at a time; a failure is not retried until the
   * session is active again.
   */
  async handoffTick(): Promise<void> {
    const cfg = this.config.claude?.handoff;
    const minutes = cfg?.idleMinutes ?? 55;
    if (minutes <= 0) return;
    await this.sources.run('handoff', async () => {
      const now = this.now();
      const due = this.db.all<HandoffSession & { last_activity_at: number }>(
        `SELECT session_id, account, env, cwd, last_activity_at FROM sessions
          WHERE state IN ('idle', 'waiting') AND last_activity_at <= ? AND last_activity_at > ? ORDER BY last_activity_at`,
        now - minutes * 60_000, now - (minutes + 15) * 60_000,
      );
      for (const s of due) {
        if ((handoffAt(this.opts.deps.home, s.session_id) ?? 0) >= s.last_activity_at) continue;
        if (Number(this.db.kvGet(`handoff_failed:${s.session_id}`) ?? 0) >= s.last_activity_at) continue;
        const last = lastMainRequest(this.db, s.session_id);
        if (!last || last.contextTokens < (cfg?.minContextTokens ?? 50_000)) continue;
        await this.safe(`handoff ${s.session_id.slice(0, 8)}`, async () => {
          try {
            const note = await writeHandoff(this.exec, this.opts.deps.home, this.config, s, last.model);
            this.log(`handoff note for ${s.session_id.slice(0, 8)} (${s.env}) written: ${note.path}`);
            const title = await this.titles.get([...new Set(accountsOf(this.config).map((a) => effectiveClaudeDir(a, this.opts.deps.home)))], s.cwd, s.session_id);
            await this.opts.notifier.send({
              title: `devhost: handoff note for ${s.env}`,
              message: `${title ? `"${title.title}" ` : ''}(${s.session_id.slice(0, 8)}) has been idle ${minutes} min. Its handoff note is ready to continue in a new session: Sessions in the app, or \`devhost session handoff ${s.session_id.slice(0, 8)}\`.`,
              tags: ['memo'],
            });
          } catch (err) {
            this.db.kvSet(`handoff_failed:${s.session_id}`, String(s.last_activity_at), now);
            throw err;
          }
        });
      }
    });
  }

  /**
   * Every minute: Tailscale's state, without peers. tailscaled answers on its unix socket (no child
   * process); `dash`, `doctor` and `status` read this sample instead of asking themselves.
   */
  async tailscaleTick(): Promise<void> {
    await this.sources.run('tailscale', async () => {
      const st = await tailscaleStatus(this.exec, TIMEOUT.tailscale);
      this.db.kvSet('tailscale', st?.BackendState ? JSON.stringify(toSample(st)) : 'unavailable', this.now());
    });
  }

  /** Daily: size per environment (worktrees, node_modules). */
  async diskUsageTick(): Promise<void> {
    await this.sources.run('disk usage', async () => {
      for (const l of this.locations()) {
        const r = await this.exec.query('du', ['-sk', l.dir], { timeoutMs: TIMEOUT.du });
        const bytes = r.code === 0 ? parseDu(r.stdout) : null;
        if (bytes !== null) this.db.run('INSERT OR REPLACE INTO env_disk (account, env, bytes, ts) VALUES (?, ?, ?, ?)', l.account, l.env, bytes, this.now());
      }
    });
  }

  async authTick(): Promise<void> {
    await this.sources.run('auth check', async () => {
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
    await this.sources.run('update', async () => {
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
            const detached = r.data.detached?.length ?? 0;
            const message = `Claude Code ${state.claude.installed} → ${r.data.claude.installed}; ${r.data.restarted?.length ?? 0} service(s) restarted${detached ? `; ${detached} open session(s) continue on claude.ai when you write in them` : ''}.`;
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
    await this.sources.run('maintenance', () => this.maintain());
  }

  private async maintain(): Promise<void> {
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
    every(60_000, () => this.sleepTick());
    every(60_000, () => this.handoffTick());
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
    // A run still going would write into a closed database.
    await this.sources.drain(5000);
  }
}
