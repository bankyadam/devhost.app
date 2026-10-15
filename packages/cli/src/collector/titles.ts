import { open } from 'node:fs/promises';
import { join } from 'node:path';

/** Claude Code's project directory name for a working directory: every non-alphanumeric is `-`. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

const CHUNK = 256 * 1024;
const MAX_TITLE = 200;

const MAX_PROMPT = 100;

export interface SessionTitle {
  title: string;
  /** No title in the transcript (Remote Control sessions keep theirs on claude.ai): the last prompt instead. */
  fromPrompt: boolean;
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Text the user typed in a `user` record; tool results and injected `<…>` blocks are not prompts. */
function promptText(d: { type?: string; message?: { content?: unknown } }): string | undefined {
  if (d.type !== 'user') return undefined;
  const c = d.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as { type?: string; text?: unknown }[]).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text as string).join(' ') : '';
  return text.trim() && !text.trim().startsWith('<') ? text : undefined;
}

/** What a chunk of transcript lines says, newest first: a title, else the last prompt. */
function scan(text: string, newestFirst: boolean): { title?: string; prompt?: string } {
  let agent: string | undefined;
  let prompt: string | undefined;
  const lines = text.split('\n');
  for (const line of newestFirst ? lines.reverse() : lines) {
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line) as { type?: string; customTitle?: unknown; agentName?: unknown; lastPrompt?: unknown; message?: { content?: unknown } };
      if (d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle.trim()) return { title: d.customTitle };
      if (d.type === 'agent-name' && typeof d.agentName === 'string' && d.agentName.trim()) agent ??= d.agentName;
      if (newestFirst && d.type === 'last-prompt' && typeof d.lastPrompt === 'string' && d.lastPrompt.trim()) prompt ??= d.lastPrompt;
      prompt ??= promptText(d);
    } catch {
      /* a line cut off by the chunk boundary */
    }
  }
  return agent ? { title: agent, prompt } : { prompt };
}

/**
 * A session's title from its transcript (`<config dir>/projects/<slug of cwd>/<id>.jsonl`), read
 * when the dashboard is built and never stored. Looks in every account's config directory: the
 * Claude app's sessions are in ~/.claude whichever account they belong to. Only the end and the
 * start of the file are read; transcripts can be large. Without a title, the last prompt.
 */
export async function sessionTitle(configDirs: readonly string[], cwd: string, sessionId: string): Promise<SessionTitle | undefined> {
  if (!cwd || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  for (const dir of configDirs) {
    let handle;
    try {
      handle = await open(join(dir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`), 'r');
    } catch {
      continue;
    }
    try {
      const size = (await handle.stat()).size;
      const read = async (from: number, length: number): Promise<string> => (await handle.read(Buffer.alloc(length), 0, length, from)).buffer.toString('utf8');
      const tailLength = Math.min(size, CHUNK);
      let found = scan(await read(size - tailLength, tailLength), true);
      if (!found.title && size > tailLength) {
        const head = scan(await read(0, Math.min(CHUNK, size - tailLength)), false);
        found = { title: head.title, prompt: found.prompt ?? head.prompt };
      }
      if (found.title) return { title: oneLine(found.title, MAX_TITLE), fromPrompt: false };
      if (found.prompt) return { title: oneLine(found.prompt, MAX_PROMPT), fromPrompt: true };
    } finally {
      await handle.close();
    }
  }
  return undefined;
}
