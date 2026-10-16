import {
  CONTRACT_VERSION,
  type AccountChangeData,
  type AccountListData,
  type ApplyData,
  type ConfigRawData,
  type DashData,
  type DevhostConfig,
  type DoctorData,
  type EnvChangeData,
  type EnvListData,
  type EnvLogsData,
  type Envelope,
  type Event,
  type LoginData,
  type PluginChangeData,
  type PluginListData,
  type PluginRunData,
  type StatusData,
  type VersionData,
} from '@devhost/contract/lite';
import type { RunResult, StreamHandle, Transport } from '../transport/types';
import { CommandError, IncompatibleError, UnreachableError, type ErrorEntry } from './errors';

export type PromptEvent = Extract<Event, { type: 'prompt' }>;
export type StepEvent = Extract<Event, { type: 'step' }>;
export type LogEvent = Extract<Event, { type: 'log' }>;
export type Range = DashData['range'];

export interface Answered {
  ok: boolean;
  exit: number;
  data: unknown;
  errors: ErrorEntry[];
}

export interface LongHandlers {
  onEvent?: (e: Event) => void;
  /** Answer a prompt event; the value is written to the command's stdin as `{"id","value"}`. */
  onPrompt?: (p: PromptEvent) => Promise<string | boolean>;
}

export interface LongRun<T> {
  promise: Promise<LongResult<T>>;
  cancel(): void;
}

export interface LongResult<T> {
  ok: boolean;
  /** devhost's exit code (0 ok, 1 checks failed, 2 usage/config, 3 human action, 130 cancelled). */
  exit: number;
  data: T | null;
  errors: ErrorEntry[];
}

/** ssh itself failing (255), a timeout (124) or the binary being absent from the host (127). */
function isTransportFailure(r: RunResult): boolean {
  return r.code === 255 || r.code === 124 || (r.code === 127 && r.stdout.trim() === '');
}

const firstLine = (s: string): string => s.trim().split('\n')[0]?.trim() ?? '';

function lastJsonLine(text: string): unknown {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!);
    } catch {
      /* keep looking: a remote login banner or warning may precede the JSON */
    }
  }
  return null;
}

/** Typed `devhost --json` calls (the contract in spec A9) over a Transport. */
export class DevhostClient {
  constructor(readonly transport: Transport) {}

  /** A short command: one JSON envelope on stdout. */
  async call<T>(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<Answered & { data: T }> {
    const r = await this.transport.run([...args, '--json'], opts);
    if (isTransportFailure(r)) {
      throw new UnreachableError(r.code === 124 ? 'The Mac mini did not answer in time.' : `Could not reach ${this.transport.host}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : '.'}`, r.stderr);
    }
    const env = lastJsonLine(r.stdout) as Envelope | null;
    if (!env || typeof env !== 'object' || !('contractVersion' in env)) {
      throw new CommandError(r.stderr.trim() || `devhost ${args[0] ?? ''} printed no JSON (exit ${r.code})`, 'bad-output', r.code);
    }
    return { ok: env.ok, exit: r.code, data: env.data as T, errors: env.errors };
  }

  /** A short command that must succeed; its `data` is returned. */
  async short<T>(args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<T> {
    const a = await this.call<T>(args, opts);
    if (!a.ok) throw commandError(a);
    return a.data;
  }

  /** Spec B2: refuse to run against an incompatible contract major. */
  async version(): Promise<VersionData> {
    const v = await this.short<VersionData>(['version']);
    if (v.contractVersion !== CONTRACT_VERSION) throw new IncompatibleError(v.cliVersion, v.contractVersion, CONTRACT_VERSION);
    return v;
  }

  status = (): Promise<StatusData> => this.short(['status']);
  dash = (range: Range, f: { account?: string; env?: string; model?: string } = {}): Promise<DashData> =>
    this.short(['dash', '--range', range, ...flag('--account', f.account), ...flag('--env', f.env), ...flag('--model', f.model)]);
  accounts = (): Promise<AccountListData> => this.short(['account', 'list']);
  envs = (): Promise<EnvListData> => this.short(['env', 'list']);
  envLogs = (name: string, lines = 200): Promise<EnvLogsData> => this.short(['env', 'logs', name, '-n', String(lines)]);
  collectorLogs = (lines = 200): Promise<EnvLogsData> => this.short(['collector', 'logs', '-n', String(lines)]);
  configRaw = (): Promise<ConfigRawData> => this.short(['config', 'raw']);
  configGet = (): Promise<DevhostConfig> => this.short<{ pointer: string; value: DevhostConfig }>(['config', 'get']).then((d) => d.value);

  /** Doctor reports problems through its data, so a failing exit code is not an error here. */
  async doctor(): Promise<DoctorData> {
    const a = await this.call<DoctorData>(['doctor'], { timeoutMs: 120_000 });
    if (!a.data || !('checks' in (a.data as object))) throw commandError(a);
    return a.data;
  }

  /** Live validation of a candidate config; the CLI on the Mac mini is the authority (schema + semantic rules). */
  async validateConfig(text: string): Promise<{ valid: boolean; issues: ErrorEntry[] }> {
    const a = await this.call<unknown>(['config', 'validate', '--stdin'], { stdin: text });
    return { valid: a.ok, issues: a.ok ? [] : a.errors };
  }

  /** Replace the config; refused by the CLI when it does not validate. */
  putConfig = (text: string): Promise<unknown> => this.short(['config', 'put'], { stdin: text });

  /** A long-running command: NDJSON events, prompts answered through stdin, a final result. */
  run<T = unknown>(args: string[], handlers: LongHandlers = {}): LongRun<T> {
    // The line callback may run as soon as the stream starts, so it reaches the handle through a holder.
    const ref: { handle?: StreamHandle } = {};
    let result: { ok: boolean; data: T | null; errors: ErrorEntry[] } | null = null;
    const pendingPrompts: Promise<void>[] = [];

    const handle = (ref.handle = this.transport.stream([...args, '--json'], (line) => {
      let ev: Event;
      try {
        ev = JSON.parse(line) as Event;
      } catch {
        return; // a remote warning or banner
      }
      if (ev.type === 'result') {
        result = { ok: ev.ok, data: (ev.data ?? null) as T | null, errors: ev.errors ?? [] };
        return;
      }
      handlers.onEvent?.(ev);
      if (ev.type === 'prompt') {
        const p = (handlers.onPrompt?.(ev) ?? Promise.resolve(false)).then((value) => ref.handle?.write(JSON.stringify({ id: ev.id, value })));
        pendingPrompts.push(p.catch(() => ref.handle?.cancel()));
      }
    }));

    let cancelled = false;
    const promise = handle.done.then(async (code): Promise<LongResult<T>> => {
      await Promise.allSettled(pendingPrompts);
      if (!result && cancelled) return { ok: false, exit: 130, data: null, errors: [{ code: 'cancelled', message: 'cancelled' }] };
      if (!result) {
        if (code === 255 || code === 127) throw new UnreachableError(`The connection to ${this.transport.host} was lost.`);
        return { ok: false, exit: code, data: null, errors: [{ code: code === 130 ? 'cancelled' : 'no-result', message: code === 130 ? 'cancelled' : 'the command ended without a result' }] };
      }
      return { ok: result.ok, exit: code, data: result.data, errors: result.errors };
    });
    return { promise, cancel: () => { cancelled = true; handle.cancel(); } };
  }

  apply = (dryRun: boolean, handlers?: LongHandlers): LongRun<ApplyData> => this.run<ApplyData>(['apply', ...(dryRun ? ['--dry-run'] : [])], handlers);
  login = (account: string, handlers?: LongHandlers): LongRun<LoginData> => this.run<LoginData>(['login', account], handlers);

  /** `dash --follow`: a snapshot every sampleIntervalSeconds until `cancel()`. */
  follow(range: Range, f: { account?: string; env?: string; model?: string }, onSnapshot: (d: DashData) => void): LongRun<null> {
    return this.run<null>(['dash', '--follow', '--range', range, ...flag('--account', f.account), ...flag('--env', f.env), ...flag('--model', f.model)], {
      onEvent: (e) => {
        if ((e as { type: string }).type === 'snapshot') onSnapshot((e as unknown as { data: DashData }).data);
      },
    });
  }

  accountAdd(o: AccountAddInput, h?: LongHandlers): LongRun<AccountChangeData> {
    return this.run(accountAddArgs(o), h);
  }
  accountRemove = (name: string, logout: boolean, h?: LongHandlers): LongRun<AccountChangeData> => this.run(['account', 'remove', name, ...(logout ? ['--logout'] : [])], h);

  envCreate(o: EnvCreateInput, h?: LongHandlers): LongRun<EnvChangeData> {
    return this.run(envCreateArgs(o), h);
  }
  envDelete = (name: string, deleteFiles: boolean, h?: LongHandlers): LongRun<EnvChangeData> => this.run(['env', 'delete', name, ...(deleteFiles ? ['--delete-files'] : [])], h);
  envService = (name: string, action: 'start' | 'stop' | 'restart', h?: LongHandlers): LongRun<EnvChangeData> => this.run(['env', action, name], h);

  plugins = (): Promise<PluginListData> => this.short<PluginListData>(['plugin', 'list']);
  pluginInstall = (source: string, enable: boolean, h?: LongHandlers): LongRun<PluginChangeData> => this.run<PluginChangeData>(['plugin', 'install', source, ...(enable ? ['--enable'] : [])], h);
  pluginUninstall = (name: string): Promise<PluginChangeData> => this.short<PluginChangeData>(['plugin', 'uninstall', name]);
  pluginToggle = (name: string, enabled: boolean): Promise<PluginChangeData> => this.short<PluginChangeData>(['plugin', enabled ? 'enable' : 'disable', name]);
  pluginRun = (plugin: string, action: string, target: PluginTarget, dryRun: boolean, h?: LongHandlers): LongRun<PluginRunData> =>
    this.run<PluginRunData>(pluginRunArgs(plugin, action, target, dryRun), h);
}

export interface PluginTarget {
  env?: string;
  session?: string;
}

export const pluginRunArgs = (plugin: string, action: string, target: PluginTarget, dryRun: boolean): string[] => ['plugin', 'run', plugin, action, ...flag('--env', target.env), ...flag('--session', target.session), ...(dryRun ? ['--dry-run'] : [])];

const flag = (name: string, value: string | undefined): string[] => (value === undefined || value === '' ? [] : [name, value]);

export interface AccountAddInput { name: string; gitEmail: string; gitName?: string; isDefault: boolean; dailyCostAlert?: number }
export interface EnvCreateInput { account: string; name: string; repo?: string; remoteControl: boolean; permissionMode?: string; compose: 'auto' | 'off' }

/**
 * Arguments of `devhost account add` / `env create`, shared by the app's own run and its "Open in
 * Terminal" fallback, so a retry in the Terminal is the same command (it continues the setup).
 */
export const accountAddArgs = (o: AccountAddInput): string[] =>
  ['account', 'add', '--name', o.name, '--git-email', o.gitEmail, ...flag('--git-name', o.gitName), ...(o.isDefault ? ['--default'] : []), ...flag('--daily-cost-alert', o.dailyCostAlert?.toString())];
export const envCreateArgs = (o: EnvCreateInput): string[] =>
  ['env', 'create', '--account', o.account, '--name', o.name, ...flag('--repo', o.repo), ...(o.remoteControl ? [] : ['--no-rc']), ...flag('--permission-mode', o.permissionMode), '--compose', o.compose];

export function commandError(a: Answered): CommandError {
  const first = a.errors[0];
  return new CommandError(first?.message ?? 'the command failed', first?.code ?? 'failed', a.exit, a.errors, first?.hint);
}
