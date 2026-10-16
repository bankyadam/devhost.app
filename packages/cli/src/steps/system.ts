import type { DevhostConfig } from '@devhost/contract';
import { HumanActionRequired } from '../errors.js';
import type { Executor } from '../runner/executor.js';
import { rootHelperStep } from './root-helper.js';
import { ok, skip, todo, type Step } from './types.js';

const HOSTNAME_KEYS = ['ComputerName', 'HostName', 'LocalHostName'] as const;

export const hostnameStep: Step = {
  id: 'system.hostname',
  description: 'Set ComputerName, HostName and LocalHostName',
  async check({ config, exec }) {
    const want = config.machine.hostname;
    const wrong: string[] = [];
    for (const key of HOSTNAME_KEYS) {
      const r = await exec.query('scutil', ['--get', key]);
      if (r.code !== 0 || r.stdout.trim() !== want) wrong.push(key);
    }
    return wrong.length === 0 ? ok() : todo(`${wrong.join(', ')} should be "${want}"`);
  },
  async apply({ config, exec }) {
    for (const key of HOSTNAME_KEYS) {
      await exec.exec('scutil', ['--set', key, config.machine.hostname], {
        sudo: true,
        reason: `set ${key} to "${config.machine.hostname}"`,
      });
    }
  },
};

type PowerKey = 'sleep' | 'disksleep' | 'autorestart' | 'womp';

function wantedPower(power: { neverSleep?: boolean; autoRestartAfterPowerLoss?: boolean; wakeOnLan?: boolean }): [PowerKey, number][] {
  const want: [PowerKey, number][] = [];
  if (power.neverSleep) want.push(['sleep', 0], ['disksleep', 0]);
  if (power.autoRestartAfterPowerLoss) want.push(['autorestart', 1]);
  if (power.wakeOnLan) want.push(['womp', 1]);
  return want;
}

/** All values `pmset -g custom` reports for a key, across power profiles. */
export function pmsetValues(output: string, key: string): number[] {
  const values: number[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*([a-z]+)\s+(\d+)\b/.exec(line);
    if (m && m[1] === key) values.push(Number(m[2]));
  }
  return values;
}

/** Settings `pmset -g cap` lists (one indented name per line); null when it cannot be read. */
export function pmsetCapabilities(output: string): Set<string> | null {
  const keys = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^\s+([a-z]+)\s*$/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return keys.size > 0 ? keys : null;
}

export interface PowerState {
  /** Requested settings this Mac supports. */
  want: [PowerKey, number][];
  /** Requested settings this Mac does not have (autorestart on a laptop): pmset ignores them. */
  unsupported: PowerKey[];
  /** Supported settings that differ, as "key should be value"; null when pmset cannot be read. */
  wrong: string[] | null;
}

export async function powerState(config: DevhostConfig, exec: Executor): Promise<PowerState> {
  const requested = wantedPower(config.machine.power ?? {});
  const cap = await exec.query('pmset', ['-g', 'cap']);
  const caps = cap.code === 0 ? pmsetCapabilities(cap.stdout) : null;
  const want = caps ? requested.filter(([k]) => caps.has(k)) : requested;
  const unsupported = caps ? requested.filter(([k]) => !caps.has(k)).map(([k]) => k) : [];
  if (want.length === 0) return { want, unsupported, wrong: [] };
  const r = await exec.query('pmset', ['-g', 'custom']);
  if (r.code !== 0) return { want, unsupported, wrong: null };
  const wrong = want
    .filter(([key, value]) => {
      const seen = pmsetValues(r.stdout, key);
      return seen.length === 0 || seen.some((v) => v !== value);
    })
    .map(([k, v]) => `${k} should be ${v}`);
  return { want, unsupported, wrong };
}

export const unsupportedPowerNote = (keys: PowerKey[]): string =>
  `this Mac does not support ${keys.join(', ')} (pmset -g cap; only desktop Macs restart after a power loss), so ${keys.length === 1 ? 'it is' : 'they are'} left alone`;

export const powerStep: Step = {
  id: 'system.power',
  description: 'Never sleep, restart after power loss, wake on LAN',
  async check({ config, exec }) {
    if (wantedPower(config.machine.power ?? {}).length === 0) return skip('no power settings requested');
    const { want, unsupported, wrong } = await powerState(config, exec);
    if (want.length === 0) return skip(unsupportedPowerNote(unsupported));
    if (unsupported.length > 0) exec.warn(unsupportedPowerNote(unsupported));
    if (wrong === null) return todo('could not read power settings');
    return wrong.length === 0 ? ok() : todo(wrong.join(', '));
  },
  async apply({ config, exec }) {
    const { want } = await powerState(config, exec);
    await exec.exec('pmset', ['-a', ...want.flatMap(([k, v]) => [k, String(v)])], {
      sudo: true,
      reason: 'change power settings so the server never sleeps',
    });
  },
};

export const sshStep: Step = {
  id: 'system.ssh',
  description: 'Enable Remote Login (SSH)',
  async check({ config, exec }) {
    if (!config.network?.ssh) return skip('network.ssh is false');
    const r = await exec.query('nc', ['-z', '-w', '2', '127.0.0.1', '22']);
    return r.code === 0 ? ok() : todo('nothing is listening on port 22');
  },
  async apply({ exec }) {
    const r = await exec.exec('systemsetup', ['-setremotelogin', 'on'], {
      sudo: true,
      reason: 'turn on Remote Login (SSH)',
      allowFailure: true,
    });
    if (r.code !== 0) {
      const text = `${r.stdout}\n${r.stderr}`;
      if (/full disk access/i.test(text)) {
        throw new HumanActionRequired(
          'macOS blocked enabling Remote Login from the command line (Full Disk Access).',
          [
            'Do one of the following on the Mac mini, then re-run `devhost apply`:',
            '  1. System Settings → General → Sharing → turn on "Remote Login".',
            '  2. System Settings → Privacy & Security → Full Disk Access → add your terminal app, restart it.',
          ].join('\n'),
        );
      }
      throw new HumanActionRequired(
        `could not enable Remote Login: ${text.trim().split('\n')[0] ?? `exit ${r.code}`}`,
        'Turn it on in System Settings → General → Sharing → Remote Login, then re-run `devhost apply`.',
      );
    }
  },
};

export const systemSteps: Step[] = [rootHelperStep, hostnameStep, powerStep, sshStep];
