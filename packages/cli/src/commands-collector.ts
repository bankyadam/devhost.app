import { existsSync, readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { DashData, DevhostConfig, EnvLogsData, NotifyData } from '@devhost/contract';
import { accountsOf, effectiveClaudeDir, logsDir } from './config/accounts.js';
import { readTextIfExists } from './fsutil.js';
import { Collector } from './collector/run.js';
import { Db, dbPath } from './collector/db.js';
import { createNotifier, maskTopic } from './collector/notify.js';
import { buildDash, RANGES, type Range } from './collector/query.js';
import { sessionTitle } from './collector/titles.js';
import { renderTop } from './collector/top.js';
import { long, short, type GlobalOptions } from './command-support.js';
import { loadConfig, parseConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, UsageError } from './errors.js';

/** Re-reads the config file when it changes; a broken edit keeps the previous config running. */
function watchConfig(path: string, initial: DevhostConfig, log: (m: string) => void): () => DevhostConfig {
  let current = initial;
  let mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
  return () => {
    try {
      const m = statSync(path).mtimeMs;
      if (m !== mtime) {
        mtime = m;
        current = parseConfig(readFileSync(path, 'utf8'), path);
        log('config reloaded');
      }
    } catch (err) {
      log(`config reload failed, keeping the previous one: ${(err as Error).message}`);
    }
    return current;
  };
}

/** `devhost collector run`: foreground; used by launchd and for debugging. */
export async function collectorRunCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  const log = (m: string): void => void deps.stderr.write(`${new Date(deps.now()).toISOString()} ${m}\n`);
  let db: Db | null = null;
  let collector: Collector | null = null;
  try {
    const { config } = await loadConfig(g.configPath);
    db = new Db(dbPath(deps.home));
    collector = new Collector({ db, config: watchConfig(g.configPath, config, log), deps, notifier: createNotifier(config), now: () => deps.now().getTime(), log, selfCommand: [process.execPath, '--disable-warning=ExperimentalWarning', process.argv[1]!, '--config', g.configPath] });
    await collector.start();
    while (!deps.cancel.cancelled) await new Promise((r) => setTimeout(r, 200));
    log('stopping');
    return 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      deps.stderr.write(`❌ the collector port is already in use (is another collector running?)\n`);
      return 1;
    }
    deps.stderr.write(`❌ ${e.message}\n`);
    return err instanceof DevhostError ? err.exitCode : 1;
  } finally {
    await collector?.stop();
    db?.close();
  }
}

export function collectorLogsCommand(deps: Deps, g: GlobalOptions, o: { lines: number }): Promise<number> {
  return short<EnvLogsData>(deps, g, async () => {
    const path = join(logsDir(deps.home), 'collector.log');
    const text = await readTextIfExists(path);
    if (text === null) throw new DevhostError(`no log yet: ${path}`, 'no-log', 1, 'The collector has not started. Run `devhost apply`.');
    const lines = text.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1).slice(-o.lines);
    return { data: { name: 'collector', path, lines }, human: lines.join('\n') };
  });
}

export interface DashOptions {
  range: string;
  account?: string;
  env?: string;
  model?: string;
  follow: boolean;
}

async function snapshot(deps: Deps, g: GlobalOptions, config: DevhostConfig, o: DashOptions): Promise<DashData> {
  const path = dbPath(deps.home);
  if (!existsSync(path)) throw new DevhostError('no data yet: the collector has not run', 'no-data', 1, 'Run `devhost apply` to install the collector service, or `devhost collector run` to start it by hand.');
  if (!RANGES.includes(o.range as Range)) throw new UsageError(`--range must be one of ${RANGES.join(', ')}`);
  const db = new Db(path, { readonly: true });
  try {
    const size = (await stat(path)).size + (await stat(`${path}-wal`).then((s) => s.size, () => 0));
    const dash = buildDash(db, config, { range: o.range as Range, account: o.account, env: o.env, model: o.model }, deps.now().getTime(), hostname(), size);
    const dirs = [...new Set(accountsOf(config).map((a) => effectiveClaudeDir(a, deps.home)))];
    const cwd = (id: string): string => db.get<{ cwd: string }>('SELECT cwd FROM sessions WHERE session_id = ?', id)?.cwd ?? '';
    const sessions = await Promise.all(
      dash.sessions.map(async (s) => {
        const t = await sessionTitle(dirs, cwd(s.id), s.id);
        return t ? { ...s, title: t.title, ...(t.fromPrompt ? { titleFromPrompt: true } : {}) } : s;
      }),
    );
    return { ...dash, sessions };
  } finally {
    db.close();
  }
}

export async function dashCommand(deps: Deps, g: GlobalOptions, o: DashOptions): Promise<number> {
  if (!o.follow) {
    return short<DashData>(deps, g, async () => {
      const { config } = await loadConfig(g.configPath);
      const data = await snapshot(deps, g, config, o);
      return { data, human: renderTop(data) };
    });
  }
  // --follow: NDJSON snapshot events every sampleIntervalSeconds until cancelled.
  return long(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const every = (config.collector?.sampleIntervalSeconds ?? 5) * 1000;
    while (!deps.cancel.cancelled) {
      const data = await snapshot(deps, g, config, o);
      if (g.json) deps.stdout.write(`${JSON.stringify({ type: 'snapshot', data })}\n`);
      else deps.stdout.write(`${deps.stdoutIsTTY ? '\u001b[2J\u001b[H' : ''}${renderTop(data)}\n`);
      for (let waited = 0; waited < every && !deps.cancel.cancelled; waited += 200) await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: true, data: null };
  });
}

export async function topCommand(deps: Deps, g: GlobalOptions, o: { once: boolean }): Promise<number> {
  return dashCommand(deps, { ...g, json: false }, { range: '1h', follow: !o.once && deps.stdoutIsTTY });
}

export function notifyCommand(deps: Deps, g: GlobalOptions, o: { test: boolean }, fetchImpl?: Parameters<typeof createNotifier>[1]): Promise<number> {
  return short<NotifyData>(deps, g, async () => {
    if (!o.test) throw new UsageError('nothing to do', 'Use `devhost notify --test` to send a test notification.');
    const { config } = await loadConfig(g.configPath);
    const notifier = createNotifier(config, fetchImpl);
    try {
      await notifier.send({ title: 'devhost: test', message: `Test notification from ${hostname()}. Notifications work.`, priority: 'default', tags: ['white_check_mark'] });
    } catch (err) {
      throw new DevhostError(`could not send the notification: ${(err as Error).message}`, 'notify-failed', 1, 'Check the network and notify.server / notify.topic in the config.');
    }
    const data = { sent: true, provider: notifier.provider, topic: maskTopic(config.notify.topic) };
    return { data, human: `✅ Sent a test notification through ${data.provider} (topic ${data.topic}). Anyone who knows the full topic can read your notifications.` };
  });
}

