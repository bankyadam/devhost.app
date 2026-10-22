import { whichBinary } from '../state.js';
import { tailscaleStatus } from '../tailscale-status.js';
import { ok, skip, todo, type Step } from './types.js';

/**
 * Tailscale runs as the Homebrew `tailscaled` system daemon (`sudo brew services`),
 * so it is up at boot without a GUI login. Logging in is never automated.
 */
export const tailscaleStep: Step = {
  id: 'tailscale',
  description: 'Run the Tailscale daemon at boot',
  async check({ config, exec }) {
    if (!config.network?.tailscale) return skip('network.tailscale is false');
    if (!(await whichBinary(exec, 'tailscale'))) return todo('tailscale is not installed yet');
    const status = await tailscaleStatus(exec);
    if (!status?.BackendState) return todo('the tailscaled daemon is not running');
    if (status.BackendState !== 'Running') {
      exec.warn('Tailscale is not logged in. Run `sudo tailscale up` and open the URL it prints (devhost never automates this login).');
    }
    return ok();
  },
  async apply({ exec }) {
    await exec.exec('brew', ['services', 'start', 'tailscale'], {
      sudo: true,
      reason: 'run tailscaled as a system daemon so it starts at boot without a GUI login',
    });
    await exec.waitFor(async () => (await tailscaleStatus(exec))?.BackendState !== undefined, 15, 1000);
    const status = await tailscaleStatus(exec);
    if (status && status.BackendState !== 'Running') {
      exec.warn('Tailscale is not logged in. Run `sudo tailscale up` and open the URL it prints (devhost never automates this login).');
    }
  },
};
