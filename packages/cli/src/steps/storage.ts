import { HumanActionRequired } from '../errors.js';
import { daemonState } from '../launchd.js';
import { AUTODISKMOUNT, automountWithoutLogin, enableOwnership, installUnlockDaemon, passphraseStored, spotlightOff, UNLOCK_LABEL, unlockPlistInstalled, unlockPlistUuid, removeUnlockDaemon } from '../storage/root.js';
import { volumeStatus, workVolumeOf, type VolumeStatus } from '../storage/volume.js';
import { ok, skip, todo, type Step, type StepContext } from './types.js';

/**
 * The external work volume (spec A7.12). Every step skips without `storage.workVolume`, and an
 * unchanged volume re-checks to `ok`: nothing is restarted or rewritten (spec A7, running sessions).
 */
const ready = async (ctx: StepContext): Promise<VolumeStatus | null> => {
  const v = workVolumeOf(ctx.config);
  return v ? volumeStatus(ctx.exec, v) : null;
};

const notReady = (s: VolumeStatus): string =>
  !s.mounted ? `${s.mountPoint} is not mounted${s.strayDirectory ? ' (a plain directory is in its place)' : ''}`
  : !s.uuidMatch ? `the volume at ${s.mountPoint} is not ${s.uuid}`
  : `${s.mountPoint}/.devhost-volume does not name ${s.uuid}`;

export const storageVolumeStep: Step = {
  id: 'storage.volume',
  description: 'The work volume is mounted and is the configured one (uuid and marker)',
  async check(ctx) {
    const s = await ready(ctx);
    if (!s) return skip('no storage.workVolume');
    return s.ready ? ok() : todo(notReady(s));
  },
  async apply(ctx) {
    const s = (await ready(ctx))!;
    throw new HumanActionRequired(`the work volume is not ready: ${notReady(s)}`, s.strayDirectory ? `Move ${s.mountPoint} aside (it is a directory on the internal disk, not the volume), then connect the volume.` : 'Connect (and unlock) the volume, then run `devhost apply` again. `devhost storage status` shows its state.');
  },
};

export const storageOwnershipStep: Step = {
  id: 'storage.ownership',
  description: 'The work volume honors file owners (external volumes ignore them by default)',
  async check(ctx) {
    const s = await ready(ctx);
    if (!s) return skip('no storage.workVolume');
    if (!s.ready) return skip('the volume is not ready');
    return s.ownership ? ok() : todo('ownership is not enabled on the volume');
  },
  async apply(ctx) {
    await enableOwnership(ctx.exec, workVolumeOf(ctx.config)!.uuid.toUpperCase());
  },
};

export const storageSpotlightStep: Step = {
  id: 'storage.spotlight',
  description: 'Spotlight indexing off on the work volume (storage.workVolume.spotlight: false)',
  async check(ctx) {
    const v = workVolumeOf(ctx.config);
    if (!v) return skip('no storage.workVolume');
    if (v.spotlight === true) return skip('spotlight: true (left alone)');
    const s = await ready(ctx);
    if (!s?.ready) return skip('the volume is not ready');
    const r = await ctx.exec.query('mdutil', ['-s', s.mountPoint]);
    return /disabled/i.test(r.stdout) ? ok() : todo('Spotlight indexes the volume');
  },
  async apply(ctx) {
    await spotlightOff(ctx.exec, (await ready(ctx))!.mountPoint);
  },
};

export const storageAutomountStep: Step = {
  id: 'storage.automount',
  description: 'External volumes mount at boot without a login (AutomountDisksWithoutUserLogin)',
  async check(ctx) {
    if (!workVolumeOf(ctx.config)) return skip('no storage.workVolume');
    const r = await ctx.exec.query('defaults', ['read', AUTODISKMOUNT, 'AutomountDisksWithoutUserLogin']);
    return r.code === 0 && /^(1|true|YES)$/i.test(r.stdout.trim()) ? ok() : todo(`${AUTODISKMOUNT} AutomountDisksWithoutUserLogin is not set`);
  },
  async apply(ctx) {
    await automountWithoutLogin(ctx.exec);
  },
};

export const storageUnlockStep: Step = {
  id: 'storage.unlock',
  description: 'Unlock the encrypted work volume at boot, without a login (root service, passphrase in the System keychain)',
  async check(ctx) {
    const v = workVolumeOf(ctx.config);
    if (!v?.encrypted) {
      // A service left from an earlier volume or from encrypted: true would keep unlocking it.
      if (await unlockPlistInstalled(ctx.exec)) return todo(`${UNLOCK_LABEL} is installed but no encrypted work volume is configured`);
      return skip(v ? 'encrypted: false' : 'no storage.workVolume');
    }
    if (!(await passphraseStored(ctx.exec))) return todo('no passphrase in the System keychain');
    if (!(await unlockPlistInstalled(ctx.exec))) return todo(`${UNLOCK_LABEL} is not installed`);
    if ((await unlockPlistUuid(ctx.exec)) !== v.uuid.toUpperCase()) return todo(`${UNLOCK_LABEL} unlocks another volume than ${v.uuid}`);
    return (await daemonState(ctx.exec, UNLOCK_LABEL)).loaded ? ok() : todo(`${UNLOCK_LABEL} is not loaded`);
  },
  async apply(ctx) {
    const v = workVolumeOf(ctx.config);
    if (!v?.encrypted) {
      await removeUnlockDaemon(ctx.exec);
      return;
    }
    if (!(await passphraseStored(ctx.exec))) {
      throw new HumanActionRequired('the work volume passphrase is not in the System keychain', 'Store it once (it is read from stdin, never from the command line): devhost storage set-passphrase');
    }
    await installUnlockDaemon(ctx.exec, ctx.home, v.uuid.toUpperCase());
  },
};

/**
 * In `apply` order: what lets the volume mount and unlock at boot, then its identity (a volume that
 * is not the configured one stops here), then what is done on it.
 */
export const storageSteps: Step[] = [storageAutomountStep, storageUnlockStep, storageVolumeStep, storageOwnershipStep, storageSpotlightStep];
