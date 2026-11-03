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
  /** Notification: its type (permission_prompt, idle_prompt, ...), never its message. */
  notificationType?: string;
}

/** Session ids are UUIDs; anything else is refused at ingest (they end up in file names and argv). */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CWD = 1024;
const MAX_AGENT_ID = 128;

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
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const cwd = typeof b['cwd'] === 'string' ? b['cwd'].slice(0, MAX_CWD) : '';
  if (isAgentEvent(event)) {
    const agentId = typeof b['agent_id'] === 'string' ? b['agent_id'] : '';
    if (agentId === '' || agentId.length > MAX_AGENT_ID) return null;
    const agentType = typeof b['agent_type'] === 'string' ? b['agent_type'].slice(0, 80) : '';
    return { event, sessionId, cwd, agentId, agentType };
  }
  if (!(event in STATE_FOR)) return null;
  if (event === 'Notification') {
    const t = typeof b['notification_type'] === 'string' ? b['notification_type'].slice(0, 40) : '';
    return { event, sessionId, cwd, notificationType: t };
  }
  return { event, sessionId, cwd };
}

/** Notification types that mean the session waits for the user (a permission or a question). */
const WAITING_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog'];

/**
 * The state an event sets, or undefined when it leaves it alone: other notifications (an idle
 * reminder, a finished login) say nothing about what the session is doing.
 */
export function stateForEvent(event: string, notificationType?: string): SessionState | undefined {
  if (event === 'Notification') return notificationType !== undefined && WAITING_NOTIFICATIONS.includes(notificationType) ? 'waiting' : undefined;
  return STATE_FOR[event];
}

/** Whether the event opens (true) or closes (false) the session's turn; undefined: no change. */
export const turnOpenFor = (event: string): boolean | undefined => (event === 'UserPromptSubmit' ? true : event === 'Stop' || event === 'SessionEnd' ? false : undefined);

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
