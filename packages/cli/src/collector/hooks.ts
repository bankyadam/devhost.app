import { environmentsOf, accountsOf, envDir } from '../config/accounts.js';
import type { DevhostConfig } from '@devhost/contract';

export type SessionState = 'idle' | 'running' | 'waiting' | 'ended';

/** Only these fields are ever read from a hook payload (spec A10.2 privacy rule). */
export interface HookEvent {
  event: string;
  sessionId: string;
  cwd: string;
  /** SubagentStart/SubagentStop: the subagent's id and type (e.g. "Explore"), never its prompt or answer. */
  agentId?: string;
  agentType?: string;
}

/** Hook events about subagents; they do not change the session's own state. */
export const AGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const;
const isAgentEvent = (e: string): boolean => (AGENT_EVENTS as readonly string[]).includes(e);

const STATE_FOR: Record<string, SessionState> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'running',
  Notification: 'waiting',
  Stop: 'idle',
  SessionEnd: 'ended',
};

/**
 * Extract the whitelisted fields. Everything else in the payload (prompt text,
 * last_assistant_message, tool input, transcript_path, ...) is dropped here and
 * can therefore never reach the database.
 */
export function parseHook(body: unknown): HookEvent | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const event = typeof b['hook_event_name'] === 'string' ? b['hook_event_name'] : '';
  const sessionId = typeof b['session_id'] === 'string' ? b['session_id'] : '';
  if (sessionId === '') return null;
  const cwd = typeof b['cwd'] === 'string' ? b['cwd'] : '';
  if (isAgentEvent(event)) {
    const agentId = typeof b['agent_id'] === 'string' ? b['agent_id'] : '';
    if (agentId === '') return null;
    const agentType = typeof b['agent_type'] === 'string' ? b['agent_type'].slice(0, 80) : '';
    return { event, sessionId, cwd, agentId, agentType };
  }
  if (!(event in STATE_FOR)) return null;
  return { event, sessionId, cwd };
}

export const stateForEvent = (event: string): SessionState | undefined => STATE_FOR[event];

export interface EnvLocation {
  account: string;
  env: string;
  dir: string;
}

export function envLocations(config: DevhostConfig, home: string): EnvLocation[] {
  return environmentsOf(config).flatMap((e) => {
    const a = accountsOf(config).find((x) => x.name === e.account);
    return a ? [{ account: a.name, env: e.name, dir: envDir(a, e, home) }] : [];
  });
}

/** Environment owning `cwd` (also worktrees below the environment directory). */
export function locate(locations: EnvLocation[], cwd: string): EnvLocation | undefined {
  if (cwd === '') return undefined;
  return locations
    .filter((l) => cwd === l.dir || cwd.startsWith(`${l.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}
