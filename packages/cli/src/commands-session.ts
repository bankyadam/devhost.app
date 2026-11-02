import { ExitCode, type SessionHandoffData } from '@devhost/contract';
import { Db, dbPath } from './collector/db.js';
import { long, newExecutor, type GlobalOptions } from './command-support.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError } from './errors.js';
import { handoffPath, lastMainRequest, readHandoff, writeHandoff } from './handoff.js';
import { sessionRow } from './reattach.js';

/**
 * `devhost session handoff <id>`: the session's handoff note (spec A10.10), to continue its work in
 * a new session. Shows the note written since the session's last activity; otherwise, or with
 * `--new`, writes one (a one-off fork of the session reads it all: about one request's cost).
 */
export function sessionHandoffCommand(deps: Deps, g: GlobalOptions, id: string, fresh: boolean): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const s = sessionRow(deps.home, id);
    const db = new Db(dbPath(deps.home), { readonly: true });
    let model: string | null;
    let lastActivity: number;
    try {
      model = lastMainRequest(db, s.session_id)?.model ?? null;
      lastActivity = db.get<{ t: number }>('SELECT last_activity_at AS t FROM sessions WHERE session_id = ?', s.session_id)?.t ?? 0;
    } finally {
      db.close();
    }
    const base = { session: s.session_id, account: s.account, env: s.env, path: handoffPath(deps.home, s.session_id) };
    const old = await readHandoff(deps.home, s.session_id);
    if (old && !fresh && old.at >= lastActivity) {
      const data: SessionHandoffData = { ...base, at: old.at, text: old.text, written: false };
      return { ok: true, data, human: [old.text.trimEnd(), '', `(${base.path}, written ${new Date(old.at).toLocaleString()}; --new writes it again)`] };
    }
    if (s.state === 'running') throw new DevhostError(`session ${s.session_id.slice(0, 8)} is in the middle of a turn`, 'session-busy', ExitCode.ChecksFailed, 'Write the note when the turn has ended: it would miss what the turn is doing.');
    reporter.step('session.handoff', 'start', `writing the handoff note of ${s.session_id.slice(0, 8)} (${s.env})`);
    const exec = newExecutor(deps, g, reporter, false);
    let note: Awaited<ReturnType<typeof writeHandoff>>;
    try {
      note = await writeHandoff(exec, deps.home, config, s, model);
    } catch (err) {
      reporter.step('session.handoff', 'failed');
      throw new DevhostError(`the handoff note could not be written: ${(err as Error).message}`, 'handoff-failed');
    }
    reporter.step('session.handoff', 'changed', note.path);
    const data: SessionHandoffData = { ...base, at: note.at, text: note.text, written: true };
    return { ok: true, data, human: [note.text.trimEnd(), '', `(${note.path})`] };
  });
}
