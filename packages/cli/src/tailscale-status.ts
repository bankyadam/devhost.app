import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { Db, dbPath } from './collector/db.js';
import type { Executor } from './runner/executor.js';

/** What devhost reads of `tailscale status`: the backend state and this machine only. */
export interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

/** The open source tailscaled's LocalAPI socket (the GUI variants have none). */
export const tailscaledSocket = (): string => process.env['DEVHOST_TAILSCALE_SOCKET'] ?? '/var/run/tailscaled.socket';

export type TailscaleVariant = 'tailscaled' | 'gui' | 'none';

/**
 * Which Tailscale runs here: the open source `tailscaled` (a unix socket), a GUI variant (App Store
 * or Standalone app: no socket; its CLI finds the app's API by running `lsof` on every call), or none.
 */
export function tailscaleVariant(): TailscaleVariant {
  if (existsSync(tailscaledSocket())) return 'tailscaled';
  if (existsSync(process.env['DEVHOST_TAILSCALE_APP'] ?? '/Applications/Tailscale.app')) return 'gui';
  return 'none';
}

export function parseTailscale(text: string): TailscaleStatus | null {
  try {
    return JSON.parse(text) as TailscaleStatus;
  } catch {
    return null;
  }
}

/** GET /localapi/v0/status?peers=false on tailscaled's unix socket: no child process, no lsof. */
function localApiStatus(socketPath: string, timeoutMs: number): Promise<TailscaleStatus | null> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/localapi/v0/status?peers=false', headers: { Host: 'local-tailscaled.sock' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 ? parseTailscale(body) : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Tailscale's state, without peers. tailscaled: its LocalAPI over the unix socket. Otherwise (a GUI
 * variant) the CLI, which runs `lsof` to find the app: `doctor` recommends tailscaled on a server.
 */
export async function tailscaleStatus(exec: Executor, timeoutMs = 5000): Promise<TailscaleStatus | null> {
  if (tailscaleVariant() === 'tailscaled') return localApiStatus(tailscaledSocket(), timeoutMs);
  const r = await exec.query('tailscale', ['status', '--json', '--peers=false'], { timeoutMs });
  return r.code === 0 ? parseTailscale(r.stdout) : null;
}

/** What the collector keeps of Tailscale (kv `tailscale`), refreshed every minute. */
export interface TailscaleSample {
  state: string;
  dnsName: string | null;
  ips: string[];
}

export const toSample = (st: TailscaleStatus): TailscaleSample => ({ state: st.BackendState ?? 'unknown', dnsName: st.Self?.DNSName?.replace(/\.$/, '') ?? null, ips: st.Self?.TailscaleIPs ?? [] });

/**
 * Tailscale for `doctor` and `status`: the collector's sample when it is under three minutes old,
 * else one query of its own (null: no daemon).
 */
export async function tailscaleNow(exec: Executor, home: string, now: number): Promise<TailscaleSample | null> {
  if (existsSync(dbPath(home))) {
    const db = new Db(dbPath(home), { readonly: true });
    try {
      const row = db.get<{ value: string; updated_at: number }>("SELECT value, updated_at FROM kv WHERE key = 'tailscale'");
      if (row && now - row.updated_at < 3 * 60_000 && row.value !== 'unavailable') {
        const v = JSON.parse(row.value) as Partial<TailscaleSample>;
        if (v.state) return { state: v.state, dnsName: v.dnsName ?? null, ips: v.ips ?? [] };
      }
    } catch {
      /* fall through to a query */
    } finally {
      db.close();
    }
  }
  const st = await tailscaleStatus(exec);
  return st?.BackendState ? toSample(st) : null;
}
