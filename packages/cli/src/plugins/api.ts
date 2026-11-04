import type { DashData, DevhostConfig } from '@devhost/contract';
import type { Prompter } from '../prompter.js';
import type { Reporter } from '../reporter.js';
import type { Executor } from '../runner/executor.js';

/**
 * The devhost plugin API. A plugin is an ES module whose default export is a DevhostPlugin:
 * built in (src/plugins/builtin) or in ~/.config/devhost/plugins/<name>/index.js. It runs in the
 * CLI on the Mac mini, as the user, and changes things only through `ctx.exec` (so --dry-run,
 * the plan and the root helper work as for apply). Configured under `plugins.<name>` in config.yaml.
 *
 * A plugin uses only this API (and Node's own modules), never devhost's other modules: that is
 * what lets one live in its own repository and be installed with `devhost plugin install`.
 */
export interface DevhostPlugin {
  name: string;
  version: string;
  description: string;
  actions?: PluginAction[];
  checks?: PluginCheck[];
  /** Notes on other checks, devhost's or another plugin's: `devhost doctor` shows them under that check. */
  advice?: PluginAdvice[];
  /** Cards on the desktop app's dashboard (`devhost plugin widgets`). */
  widgets?: PluginWidget[];
  /** Controls above the plugin's cards on the dashboard; their values reach every widget's `run` as `params`. */
  filters?: PluginFilter[];
}

/** Where an action applies: the whole host, one environment, or one session (the app puts it in that menu). */
export type ActionScope = 'host' | 'environment' | 'session';

export interface PluginAction {
  id: string;
  title: string;
  description: string;
  scope: ActionScope;
  /** Removes or stops something: asks for confirmation (the app, a prompt, or --yes). */
  destructive?: boolean;
  run(ctx: PluginContext, target: ActionTarget): Promise<ActionResult>;
}

export interface ActionTarget {
  environment?: EnvironmentInfo;
  session?: SessionInfo;
}

export interface ActionResult {
  /** One line for people. */
  summary: string;
  /** Anything JSON for the app or scripts. */
  data?: Record<string, unknown>;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PluginCheck {
  id: string;
  run(ctx: PluginContext): Promise<{ status: CheckStatus; message: string; fix?: string }>;
}

/** A check as doctor reported it, handed to advice. */
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface PluginAdvice {
  /** The check it speaks to, e.g. `system.disk`; `*` stands for one dot-separated part (`env.*.service`). */
  check: string;
  /** The statuses it is asked for (default warn and fail). */
  on?: CheckStatus[];
  /** Null: nothing to add this time. */
  run(ctx: PluginContext, check: DoctorCheck): Promise<Advice | null>;
}

export interface Advice {
  message: string;
  /** A command to copy; defaults to `devhost plugin run <plugin> <action>` when `action` is given. */
  fix?: string;
  /** One of this plugin's host actions that helps; the app offers it as a button. */
  action?: string;
}

export interface PluginFilter {
  id: string;
  label: string;
  /** Segmented buttons (a few fixed choices) or a drop-down. */
  kind: 'segmented' | 'select';
  /** The value when none is chosen; a select without one starts at "all" (the empty value). */
  default?: string;
  /** A select's label for the empty value, e.g. "All accounts". */
  allLabel?: string;
  options(ctx: PluginContext): Promise<{ value: string; label: string }[]>;
}

export interface PluginWidget {
  id: string;
  title: string;
  /** `wide` spans the dashboard's width (charts). */
  size?: 'normal' | 'wide';
  /** How often the app reloads it (default 300 s). */
  refreshSeconds?: number;
  /** One card, or several (one per account, say: each with its own key and title). */
  run(ctx: PluginContext, params: Record<string, string>): Promise<WidgetContent | WidgetCard[]>;
}

export interface WidgetCard extends WidgetContent {
  key: string;
  title: string;
}

/** What a dashboard card shows. Values are text: the plugin formats them (charts take numbers). */
export interface WidgetContent {
  status?: CheckStatus;
  /** One line under the title. */
  summary?: string;
  /** The card belongs to this account: it gets the account's color. */
  account?: string;
  tiles?: { label: string; value: string; sub?: string }[];
  rows?: { label: string; value: string; note?: string }[];
  /** A bar filled `value / max`; warns from 80 %, fails from 100 %. */
  meter?: { label: string; value: number; max: number };
  chart?: WidgetChart;
  /** A link shown as a QR code, for a phone to open. */
  qr?: { url: string; label?: string };
  /** Small print under the card. */
  note?: string;
  /** One of this plugin's host actions, offered as a button on the card. */
  action?: string;
}

/** Stacked columns over time. */
export interface WidgetChart {
  title: string;
  /** `colorBy: 'account'`: series keys are account names and take the accounts' colors. */
  series: { key: string; label: string }[];
  colorBy?: 'account';
  points: { ts: number; values: Record<string, number> }[];
  /** Column labels: clock times or dates. */
  axis: 'time' | 'date';
  format: 'compact' | 'usd' | 'integer' | 'percent';
  height?: number;
}

/** A dashboard query against the collector's data (what `devhost dash` shows). */
export interface StatsQuery {
  range: DashData['range'];
  account?: string;
  env?: string;
  model?: string;
}

export interface EnvironmentInfo {
  name: string;
  account: string;
  dir: string;
}

export interface SessionInfo {
  id: string;
  account: string;
  env: string;
  cwd: string;
}

export interface SessionState extends SessionInfo {
  state: 'running' | 'waiting' | 'idle' | 'ended';
  lastActivityAt: number;
}

export interface ServiceInfo {
  environment: string;
  account: string;
  label: string;
  enabled: boolean;
  running: boolean;
  pid: number | null;
}

export interface PluginContext {
  config: DevhostConfig;
  /** `plugins.<name>.options` from config.yaml. */
  options: Record<string, unknown>;
  home: string;
  user: string;
  /** The Node devhost runs on (npm is next to it). */
  nodePath: string;
  exec: Executor;
  reporter: Reporter;
  prompter: Prompter;
  environments: EnvironmentInfo[];
  /** Sessions the collector knows (newest activity first). */
  sessions(): Promise<SessionState[]>;
  /** The environments' Remote Control services and whether they run. */
  services(): Promise<ServiceInfo[]>;
  /** Each account's Claude config directory (the default account's is ~/.claude). */
  claudeDirs: { account: string; dir: string }[];
  /** Usage, cost and agents from the collector; null before the collector has data. */
  stats(q: StatsQuery): Promise<DashData | null>;
}

/** For plugin authors: identity at runtime, types at edit time. */
export const definePlugin = (p: DevhostPlugin): DevhostPlugin => p;
