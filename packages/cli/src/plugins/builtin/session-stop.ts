import type { DevhostPlugin, PluginContext, SessionInfo } from '../api.js';

/**
 * session-stop: end the local `claude` process of a Remote Control session to free its memory
 * (a few hundred MB each). Only a process a devhost Remote Control service started (its child)
 * whose working directory is the session's; never the Claude app's sessions or anything else.
 * On claude.ai the session stays in the list; a new message there may start it again.
 */

interface Proc {
  pid: number;
  ppid: number;
  rssKb: number;
  command: string;
}

export function parsePs(out: string): Proc[] {
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), command: m[4]! }] : [];
  });
}

/** PIDs of the devhost Remote Control services that are running. */
async function servicePids(ctx: PluginContext): Promise<number[]> {
  return (await ctx.services()).flatMap((s) => (s.running && s.pid ? [s.pid] : []));
}

async function cwdOf(ctx: PluginContext, pid: number): Promise<string | null> {
  const r = await ctx.exec.query('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  return r.stdout.split('\n').find((l) => l.startsWith('n/'))?.slice(1) ?? null;
}

/** The session's process: a service's child running in the session's directory. */
export async function sessionProcesses(ctx: PluginContext, s: SessionInfo): Promise<Proc[]> {
  const services = new Set(await servicePids(ctx));
  if (services.size === 0 || !s.cwd) return [];
  const procs = parsePs((await ctx.exec.query('ps', ['-axo', 'pid=,ppid=,rss=,command='])).stdout);
  const out: Proc[] = [];
  for (const p of procs.filter((x) => services.has(x.ppid) && /\bclaude\b/.test(x.command))) {
    if ((await cwdOf(ctx, p.pid)) === s.cwd) out.push(p);
  }
  return out;
}

const mb = (kb: number): string => `${Math.round(kb / 1024)} MB`;

export const sessionStop: DevhostPlugin = {
  name: 'session-stop',
  version: '1.0.0',
  description: 'Stop the local process of a Remote Control session to free its memory',
  actions: [
    {
      id: 'stop',
      title: 'Stop the session process',
      description: "Ends the session's local claude process (a child of its Remote Control service); the session stays on claude.ai",
      scope: 'session',
      destructive: true,
      async run(ctx, t) {
        const s = t.session!;
        const procs = await sessionProcesses(ctx, s);
        if (procs.length === 0) return { summary: `session ${s.id.slice(0, 8)} has no process of a devhost Remote Control service (stopped already, or the Claude app's)`, data: { stopped: [] } };
        if (procs.length > 1) {
          throw new Error(`${procs.length} processes work in ${s.cwd} (spawn: same-dir); stop the environment's service instead`);
        }
        const p = procs[0]!;
        if (ctx.exec.dryRun) {
          await ctx.exec.exec('kill', ['-TERM', String(p.pid)]);
          return { summary: `would stop session ${s.id.slice(0, 8)} (pid ${p.pid}, ${mb(p.rssKb)})`, data: { stopped: [] } };
        }
        await ctx.exec.exec('kill', ['-TERM', String(p.pid)]);
        const gone = await ctx.exec.waitFor(async () => (await ctx.exec.query('kill', ['-0', String(p.pid)])).code !== 0, 10, 500);
        if (!gone) {
          await ctx.exec.exec('kill', ['-KILL', String(p.pid)]);
        }
        return { summary: `stopped session ${s.id.slice(0, 8)} (pid ${p.pid}, ${mb(p.rssKb)} freed)${gone ? '' : ' with SIGKILL after 5 s'}`, data: { stopped: [p.pid], rssBytes: p.rssKb * 1024 } };
      },
    },
  ],
};
