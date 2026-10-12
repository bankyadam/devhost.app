import { HumanActionRequired } from '../errors.js';
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

export const powerStep: Step = {
  id: 'system.power',
  description: 'Never sleep, restart after power loss, wake on LAN',
  async check({ config, exec }) {
    const want = wantedPower(config.machine.power ?? {});
    if (want.length === 0) return skip('no power settings requested');
    const r = await exec.query('pmset', ['-g', 'custom']);
    if (r.code !== 0) return todo(`could not read power settings: ${r.stderr.trim() || `exit ${r.code}`}`);
    const wrong = want.filter(([key, value]) => {
      const seen = pmsetValues(r.stdout, key);
      return seen.length === 0 || seen.some((v) => v !== value);
    });
    return wrong.length === 0 ? ok() : todo(wrong.map(([k, v]) => `${k} should be ${v}`).join(', '));
  },
  async apply({ config, exec }) {
    const want = wantedPower(config.machine.power ?? {});
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

export const systemSteps: Step[] = [hostnameStep, powerStep, sshStep];
