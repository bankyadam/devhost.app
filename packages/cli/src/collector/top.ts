import type { DashData } from '@devhost/contract';

const pct = (v: number | null): string => (v === null ? '-' : `${v.toFixed(0)}%`);
const mb = (v: number | null): string => (v === null ? '-' : v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)}G` : `${Math.round(v / 1024 ** 2)}M`);
const tok = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(Math.round(v)));
const ago = (ms: number | null, now: number): string => {
  if (ms === null) return '-';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
}

/** Plain text, no charts: readable over SSH from a phone (spec A10.6). */
export function renderTop(d: DashData): string {
  const h = d.host;
  const lines: string[] = [
    `${h.name}  ${h.online ? 'online' : 'NO RECENT SAMPLES'}  cpu ${pct(h.cpuPercent)}  mem ${pct(h.memPercent)}  disk free ${pct(h.diskFreePercent)}  docker ${h.docker}  tailscale ${h.tailscale?.state ?? '-'}`,
  ];
  for (const a of d.alerts) lines.push(`ALERT ${a.id}: ${a.message}`);
  lines.push('');
  lines.push(
    ...table([
      ['ACCOUNT', 'LOGIN', 'TOKENS TODAY', 'COST TODAY', 'LIMIT/DAY', 'TOKENS WEEK', 'COST WEEK'],
      ...d.accounts.map((a) => [a.name, a.loggedIn === null ? '?' : a.loggedIn ? 'ok' : 'INVALID', tok(a.today.tokens), `$${a.today.costUsd.toFixed(2)}`, a.dailyCostAlertUsd === null ? '-' : `$${a.dailyCostAlertUsd}`, tok(a.week.tokens), `$${a.week.costUsd.toFixed(2)}`]),
    ]),
  );
  lines.push('');
  lines.push(
    ...table([
      ['ENVIRONMENT', 'SERVICE', 'CPU', 'RAM', 'CONTAINERS', 'PORTS', 'SESSIONS'],
      ...d.environments.map((e) => [`${e.account}/${e.name}`, e.service.state, pct(e.cpuPercent), mb(e.rssBytes), `${pct(e.containerCpuPercent)} ${mb(e.containerMemBytes)}`, e.portBase === null ? '-' : `${e.portBase}-${e.portBase + 99}`, String(e.activeSessions)]),
    ]),
  );
  lines.push('');
  const sessions = d.sessions.slice(0, 20);
  lines.push(
    ...table([
      ['ACCOUNT', 'ENV', 'SESSION', 'STATE', 'ACTIVE', 'TOKENS', 'COST', 'CPU', 'RAM'],
      ...sessions.map((s) => [s.account ?? '-', s.env ?? '-', s.id.slice(0, 8), s.state === 'waiting' ? 'WAITING' : s.state, ago(s.lastActivityAt, d.generatedAt), tok(s.tokensToday), `$${s.costToday.toFixed(2)}`, pct(s.cpuPercent), mb(s.rssBytes)]),
    ]),
  );
  if (d.sessions.length > sessions.length) lines.push(`… ${d.sessions.length - sessions.length} more`);
  lines.push('', `cost is an estimate; plan limits are not available (see devhost dash --json for details)`);
  return lines.join('\n');
}
