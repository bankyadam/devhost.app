import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ExitCode, type SessionHandoffData, type SessionListData, type SessionStartData } from '@devhost/contract';
import { Db, dbPath } from './collector/db.js';
import { localMidnight } from './collector/query.js';
import { long, newExecutor, newReporter, short, type GlobalOptions } from './command-support.js';
import { accountEnv, effectiveClaudeDir, envDir, environmentsOf, findAccount } from './config/accounts.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError } from './errors.js';
import { handoffPath, lastMainRequest, MODEL_RE, readHandoff, writeHandoff } from './handoff.js';
import { bgSessionFile, remoteSessionFrom, sessionRow } from './reattach.js';
import { toolPath } from './state.js';

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
    if (s.turn_open === 1 && s.state !== 'ended') throw new DevhostError(`session ${s.session_id.slice(0, 8)} is in the middle of a turn`, 'session-busy', ExitCode.ChecksFailed, 'Write the note when the turn has ended: it would miss what the turn is doing.');
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

/** The branch checked out in a directory (a worktree's `.git` file points at its git dir); null when detached or not in a repository. */
export function branchOf(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    try {
      let gitDir = git;
      if (statSync(git).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'));
        if (!m) return null;
        gitDir = resolve(dir, m[1]!.trim());
      }
      return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'))?.[1]?.trim() ?? null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    if (dirname(dir) === dir) return null;
  }
}

const claudeUrl = (remote: string | null): string | null => (remote ? `https://claude.ai/code/${remote}` : null);

export interface SessionListOptions {
  account?: string;
  env?: string;
  /** One session (an id or its first 8 characters), whenever it ended. */
  id?: string;
}

/**
 * `devhost session list`: the open sessions and those that ended today (with `--id`, that one
 * session however long ago it ended), from the collector's database only (no usage, cost or process
 * figures: cheap enough to poll).
 */
export function sessionListCommand(deps: Deps, g: GlobalOptions, opts: SessionListOptions): Promise<number> {
  return short<SessionListData>(deps, g, async () => {
    if (opts.id !== undefined && !/^[A-Za-z0-9-]{8,}$/.test(opts.id)) throw new DevhostError('give a session id (at least its first 8 characters)', 'usage', ExitCode.Usage);
    const path = dbPath(deps.home);
    // `*`: a database the collector has not migrated yet (it migrates when it starts) has no waiting_for.
    const rows: { session_id: string; account: string; env: string; cwd: string; state: SessionListData['sessions'][number]['state']; waiting_for?: string | null; started_at: number; last_activity_at: number; remote_session: string | null }[] = [];
    if (existsSync(path)) {
      const db = new Db(path, { readonly: true });
      try {
        rows.push(
          ...db.all<(typeof rows)[number]>(
            `SELECT * FROM sessions
             WHERE (? <> '' OR state <> 'ended' OR ended_at >= ?) AND (? = '' OR session_id LIKE ? || '%') AND (? = '' OR account = ?) AND (? = '' OR env = ?)
             ORDER BY last_activity_at DESC LIMIT 200`,
            opts.id ?? '', localMidnight(deps.now().getTime()), opts.id ?? '', opts.id ?? '', opts.account ?? '', opts.account ?? '', opts.env ?? '', opts.env ?? '',
          ),
        );
      } finally {
        db.close();
      }
    }
    const branches = new Map<string, string | null>();
    const sessions = rows.map((r): SessionListData['sessions'][number] => {
      if (!branches.has(r.cwd)) branches.set(r.cwd, r.cwd ? branchOf(r.cwd) : null);
      const remoteSession = remoteSessionFrom(r.cwd, r.remote_session)?.id ?? null;
      return {
        id: r.session_id,
        account: r.account,
        env: r.env,
        state: r.state,
        ...(r.state === 'waiting' && (r.waiting_for === 'permission' || r.waiting_for === 'question') ? { waitingFor: r.waiting_for } : {}),
        startedAt: r.started_at,
        lastActivityAt: r.last_activity_at,
        cwd: r.cwd,
        branch: branches.get(r.cwd) ?? null,
        remoteSession,
        url: claudeUrl(remoteSession),
      };
    });
    const human =
      sessions.length === 0
        ? opts.id !== undefined ? `No session ${opts.id}.` : 'No sessions today.'
        : ['ID\tENV\tSTATE\tLAST ACTIVITY\tBRANCH\tURL', ...sessions.map((s) => [s.id.slice(0, 8), s.env, s.waitingFor ? `waiting (${s.waitingFor})` : s.state, new Date(s.lastActivityAt).toLocaleTimeString(), s.branch ?? '-', s.url ?? '-'].join('\t'))].join('\n');
    return { data: { sessions }, human };
  });
}

export const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
/** How long a started session gets to write its session file and connect to Remote Control. */
const START_WAIT_MS = 30_000;
const START_POLL_MS = 500;

export interface SessionStartOptions {
  env: string;
  account?: string;
  worktree: string;
  permissionMode?: string;
  model?: string;
  name?: string;
  prompt?: string;
  /** A file to read the prompt from; `-` is stdin. */
  promptFile?: string;
  /** Tests shorten the wait for Remote Control. */
  waitMs?: number;
}

async function readPrompt(deps: Deps, opts: SessionStartOptions): Promise<string> {
  if (opts.prompt !== undefined && opts.promptFile !== undefined) throw new DevhostError('give the prompt with --prompt or --prompt-file, not both', 'usage', ExitCode.Usage);
  let text = opts.prompt;
  if (opts.promptFile === '-') {
    const chunks: Buffer[] = [];
    for await (const c of deps.stdin) chunks.push(Buffer.from(c as Buffer));
    text = Buffer.concat(chunks).toString('utf8');
  } else if (opts.promptFile !== undefined) {
    try {
      text = await readFile(opts.promptFile, 'utf8');
    } catch (err) {
      throw new DevhostError(`the prompt file could not be read: ${(err as Error).message}`, 'usage', ExitCode.Usage);
    }
  }
  if (!text?.trim()) throw new DevhostError('the prompt is empty', 'usage', ExitCode.Usage, 'Give it with --prompt <text> or --prompt-file <path|->.');
  return text;
}

/**
 * `devhost session start <env>`: a new Claude Code session in a new worktree of the environment,
 * in the background and on Remote Control (`claude --bg --remote-control --worktree`), with the
 * environment's account and ports. Returns once it is on claude.ai (or after START_WAIT_MS).
 */
export function sessionStartCommand(deps: Deps, g: GlobalOptions, opts: SessionStartOptions): Promise<number> {
  return short<SessionStartData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const e = environmentsOf(config).find((x) => x.name === opts.env);
    if (!e) throw new DevhostError(`no environment named ${opts.env}`, 'not-found', ExitCode.Usage);
    if (opts.account && opts.account !== e.account) throw new DevhostError(`environment ${e.name} belongs to account ${e.account}, not ${opts.account}`, 'usage', ExitCode.Usage);
    const a = findAccount(config, e.account);
    if (!a) throw new DevhostError(`account ${e.account} is not in the config`, 'not-found', ExitCode.Usage);
    if (!WORKTREE_NAME_RE.test(opts.worktree)) throw new DevhostError(`not a worktree name: ${opts.worktree}`, 'usage', ExitCode.Usage, 'Letters, digits, dot, dash and underscore; at most 64.');
    const mode = opts.permissionMode ?? e.remoteControl?.permissionMode ?? 'acceptEdits';
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) throw new DevhostError(`not a permission mode: ${mode}`, 'usage', ExitCode.Usage, `One of ${PERMISSION_MODES.join(', ')}.`);
    if (opts.model !== undefined && !MODEL_RE.test(opts.model)) throw new DevhostError(`not a model: ${opts.model}`, 'usage', ExitCode.Usage);
    const name = opts.name ?? `${e.name}-${opts.worktree}`;
    if (!SESSION_NAME_RE.test(name)) throw new DevhostError(`not a session name: ${name}`, 'usage', ExitCode.Usage);
    const dir = envDir(a, e, deps.home);
    if (!existsSync(dir)) throw new DevhostError(`the environment's folder is missing: ${dir}`, 'not-found', ExitCode.ChecksFailed, `Run devhost env create or devhost apply.`);
    const prompt = await readPrompt(deps, opts);

    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const claude = await toolPath(exec, deps.home, 'claudePath', 'claude', `${deps.brewPrefix}/bin/claude`);
    const env = accountEnv(a, deps.home);
    const r = await exec.query(
      claude,
      ['--bg', '--remote-control', name, '--worktree', opts.worktree, '--permission-mode', mode, ...(opts.model ? [`--model=${opts.model}`] : []), '--', prompt],
      {
        cwd: dir,
        timeoutMs: 60_000,
        env: { ...env, DEVHOST_PORT_BASE: String(e.portBase ?? 0), OTEL_RESOURCE_ATTRIBUTES: `devhost.account=${a.name},devhost.env=${e.name}` },
        ...(env['CLAUDE_CONFIG_DIR'] ? {} : { unsetEnv: ['CLAUDE_CONFIG_DIR'] }),
      },
    );
    // eslint-disable-next-line no-control-regex
    const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const jobId = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(out)?.[1];
    if (r.code !== 0 || !jobId) {
      throw new DevhostError(`claude did not start the session (exit ${r.code}): ${out.trim().split('\n').pop() ?? ''}`, 'session-start-failed', ExitCode.ChecksFailed);
    }

    const claudeDir = effectiveClaudeDir(a, deps.home);
    const deadline = Date.now() + (opts.waitMs ?? START_WAIT_MS);
    let file = await bgSessionFile(claudeDir, jobId);
    while (!file?.bridgeSessionId && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, START_POLL_MS));
      file = await bgSessionFile(claudeDir, jobId);
    }
    if (!file) throw new DevhostError(`session ${jobId} started but wrote no session file`, 'session-start-failed', ExitCode.ChecksFailed, `See claude agents; stop it with claude stop ${jobId}.`);
    const cwd = file.cwd ?? join(dir, '.claude', 'worktrees', opts.worktree);
    const data: SessionStartData = {
      id: file.sessionId,
      jobId,
      env: e.name,
      account: a.name,
      worktree: opts.worktree,
      cwd,
      branch: branchOf(cwd),
      remoteSession: file.bridgeSessionId,
      url: claudeUrl(file.bridgeSessionId),
    };
    const human = [
      `Started ${data.id.slice(0, 8)} in ${e.name} (worktree ${opts.worktree}${data.branch ? `, branch ${data.branch}` : ''}).`,
      data.url ?? 'Not on Remote Control yet: devhost session list shows its link once it connects.',
    ].join('\n');
    return { data, human };
  });
}
