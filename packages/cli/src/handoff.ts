import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { accountEnv, findAccount } from './config/accounts.js';
import type { Db } from './collector/db.js';
import type { Executor } from './runner/executor.js';
import { toolPath } from './state.js';

/**
 * Handoff notes (spec A10.10): a summary of a session that a new session can continue from. A
 * session left for an hour loses its prompt cache, and a Remote Control session often its process
 * too; the note is written before that, by a one-off fork of the session (`--fork-session
 * --no-session-persistence`: the session itself is not touched, the fork is not kept).
 */
export const HANDOFF_PROMPT = [
  'Write a handoff note so that a new Claude Code session, which sees none of this conversation, can continue this work where it stopped.',
  'Do not use any tools: answer from what this conversation already contains. Output only the note, in Markdown.',
  'Cover: the goal and what the user asked for (quote the constraints that matter); what is done and verified, and what is committed or pushed (branch);',
  'the key files, commands and facts found; decisions taken and why; what is unfinished, open or broken, and the next steps in order;',
  "the user's preferences and things to avoid. Be specific (paths, names, numbers) and brief: at most about 600 words.",
].join(' ');

/** A fork reads the whole transcript and writes a page: give it time, but not forever. */
const HANDOFF_TIMEOUT_MS = 5 * 60_000;

export const handoffPath = (home: string, sessionId: string): string => join(home, '.local', 'share', 'devhost', 'handoff', `${sessionId}.md`);

/** The note written for a session, or null. */
export async function readHandoff(home: string, sessionId: string): Promise<{ at: number; text: string } | null> {
  const path = handoffPath(home, sessionId);
  try {
    const [text, s] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { at: Math.round(s.mtimeMs), text };
  } catch {
    return null;
  }
}

/** When the note was written (unix ms), or null: for the dashboard, without reading it. */
export function handoffAt(home: string, sessionId: string): number | null {
  const path = handoffPath(home, sessionId);
  try {
    return Math.round(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/** The session's last main-thread request: its model and context (input plus cache read and write). */
export function lastMainRequest(db: Db, sessionId: string): { model: string; contextTokens: number; ts: number } | null {
  const r = db.get<{ model: string; ctx: number; ts: number }>(
    `SELECT model, COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0) AS ctx, ts
       FROM api_requests WHERE session_id = ? AND source = 'main' ORDER BY ts DESC LIMIT 1`,
    sessionId,
  );
  return r ? { model: r.model, contextTokens: Number(r.ctx), ts: Number(r.ts) } : null;
}

export interface HandoffSession {
  session_id: string;
  account: string;
  env: string;
  cwd: string;
}

/**
 * Write a session's note: `claude -p --resume <id> --fork-session` in its directory, with its
 * account and its last model, hooks off (no SessionStart: the fork is not a session to track or a
 * reason to wake the environment). Throws when Claude Code fails or answers nothing.
 */
export async function writeHandoff(exec: Executor, home: string, config: DevhostConfig, s: HandoffSession, model: string | null): Promise<{ at: number; text: string; path: string }> {
  const account = findAccount(config, s.account);
  if (!account) throw new Error(`account ${s.account} is not in the config any more`);
  if (!s.cwd || !existsSync(s.cwd)) throw new Error(`the session's directory is gone: ${s.cwd || 'none recorded'}`);
  const claude = await toolPath(exec, home, 'claudePath', 'claude', '/opt/homebrew/bin/claude');
  const r = await exec.query(
    claude,
    ['-p', '--resume', s.session_id, '--fork-session', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', ...(model ? ['--model', model] : []), HANDOFF_PROMPT],
    {
      cwd: s.cwd,
      timeoutMs: HANDOFF_TIMEOUT_MS,
      env: { ...accountEnv(account, home), OTEL_RESOURCE_ATTRIBUTES: `devhost.account=${s.account},devhost.env=${s.env}` },
      ...(accountEnv(account, home)['CLAUDE_CONFIG_DIR'] ? {} : { unsetEnv: ['CLAUDE_CONFIG_DIR'] }),
    },
  );
  const text = r.stdout.trim();
  if (r.code !== 0 || !text) throw new Error(`claude exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split('\n').pop() ?? ''}`);
  const path = handoffPath(home, s.session_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${text}\n`);
  const at = Math.round((await stat(path)).mtimeMs);
  return { at, text: `${text}\n`, path };
}
