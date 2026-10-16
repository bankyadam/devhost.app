import type { DevhostConfig } from '@devhost/contract';
import type { Prompter } from '../prompter.js';
import type { Reporter } from '../reporter.js';
import type { Executor } from '../runner/executor.js';

/**
 * The devhost plugin API. A plugin is an ES module whose default export is a DevhostPlugin:
 * built in (src/plugins/builtin) or in ~/.config/devhost/plugins/<name>/index.js. It runs in the
 * CLI on the Mac mini, as the user, and changes things only through `ctx.exec` (so --dry-run,
 * the plan and the root helper work as for apply). Configured under `plugins.<name>` in config.yaml.
 */
export interface DevhostPlugin {
  name: string;
  version: string;
  description: string;
  actions?: PluginAction[];
  checks?: PluginCheck[];
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

export interface PluginCheck {
  id: string;
  run(ctx: PluginContext): Promise<{ status: 'ok' | 'warn' | 'fail'; message: string; fix?: string }>;
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
  /** Each account's Claude config directory (the default account's is ~/.claude). */
  claudeDirs: { account: string; dir: string }[];
}

/** For plugin authors: identity at runtime, types at edit time. */
export const definePlugin = (p: DevhostPlugin): DevhostPlugin => p;
