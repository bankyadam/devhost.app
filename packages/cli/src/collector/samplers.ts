/** Parsers and small samplers for the collector (spec A10.1). The parsers are pure so they can be tested with captured output. */

export interface Proc {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  command: string;
}

/** `ps -axo pid=,ppid=,pcpu=,rss=,command=` */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), command: m[5]! });
  }
  return procs;
}

/** The process and all its descendants. */
export function subtree(procs: Proc[], rootPid: number): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const root = procs.find((p) => p.pid === rootPid);
  if (!root) return [];
  const out: Proc[] = [];
  const seen = new Set<number>();
  const walk = (p: Proc): void => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push(p);
    (children.get(p.pid) ?? []).forEach(walk);
  };
  walk(root);
  return out;
}

export const sumProcs = (ps: Proc[]): { cpu: number; rssBytes: number } => ({
  cpu: ps.reduce((a, p) => a + p.cpu, 0),
  rssBytes: ps.reduce((a, p) => a + p.rssKb * 1024, 0),
});

/** `lsof -a -d cwd -Fpn -p ...` → pid → cwd */
export function parseLsofCwd(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

export interface VmStat {
  pageSize: number;
  pages: Record<string, number>;
}

export function parseVmStat(out: string): VmStat {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
  const pages: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?$/.exec(line.trim());
    if (m) pages[m[1]!.trim().toLowerCase()] = Number(m[2]);
  }
  return { pageSize, pages };
}

/** Used memory the way Activity Monitor counts it: app + wired + compressed. */
export function memoryFromVmStat(vm: VmStat, totalBytes: number): { used: number; pct: number } {
  const p = vm.pages;
  const pagesUsed = (p['pages active'] ?? 0) + (p['pages wired down'] ?? 0) + (p['pages occupied by compressor'] ?? 0);
  const used = pagesUsed * vm.pageSize;
  return { used, pct: totalBytes > 0 ? (used / totalBytes) * 100 : 0 };
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(s.trim());
  return m ? Number(m[1]) * (UNITS[m[2]!.toLowerCase()] ?? 1) : 0;
}

export interface ContainerStat {
  name: string;
  cpu: number;
  memBytes: number;
}

/** `docker stats --no-stream --format '{{json .}}'` */
export function parseDockerStats(out: string): ContainerStat[] {
  const stats: ContainerStat[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { Name?: string; CPUPerc?: string; MemUsage?: string };
      stats.push({ name: j.Name ?? '', cpu: Number.parseFloat(j.CPUPerc ?? '0') || 0, memBytes: parseSize((j.MemUsage ?? '').split('/')[0] ?? '') });
    } catch {
      /* ignore a malformed line */
    }
  }
  return stats;
}

/** `docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}'` → container → compose project */
export function parseDockerPs(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, project] = line.split('\t');
    if (name && project) map.set(name, project);
  }
  return map;
}

/** `du -sk dir` → bytes */
export function parseDu(out: string): number | null {
  const m = /^(\d+)\s/.exec(out.trim());
  return m ? Number(m[1]) * 1024 : null;
}

/** CPU percentage between two `os.cpus()` snapshots. */
export function cpuPercent(prev: { idle: number; total: number } | null, now: { idle: number; total: number }): number | null {
  if (!prev) return null;
  const total = now.total - prev.total;
  const idle = now.idle - prev.idle;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}

export function cpuTimes(cpus: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}
