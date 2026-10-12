import type { DashData } from '@devhost/contract/lite';
import type { TrayStatus } from '../transport/types';

export interface TrayState {
  status: TrayStatus;
  waiting: number;
}

/**
 * Menu bar state (spec B3.6): red = unreachable, collector silent or an active alert;
 * yellow = something to look at (a service down, a login out, Docker down, no data yet); green otherwise.
 */
export function trayState(reachable: boolean, dash: DashData | null): TrayState {
  if (!reachable) return { status: 'red', waiting: 0 };
  if (!dash) return { status: 'yellow', waiting: 0 };
  const waiting = dash.sessions.filter((s) => s.state === 'waiting').length;
  if (!dash.host.online || dash.alerts.length > 0) return { status: 'red', waiting };
  const degraded =
    dash.host.docker === 'down' ||
    dash.accounts.some((a) => a.loggedIn === false) ||
    dash.environments.some((e) => e.service.state === 'stopped');
  return { status: degraded ? 'yellow' : 'green', waiting };
}
