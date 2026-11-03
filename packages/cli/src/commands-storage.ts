import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DevhostConfig, StorageChangeData, StorageListData, StorageStatusData } from '@devhost/contract';
import { runSteps } from './apply.js';
import { long, newExecutor, newReporter, newStepContext, short, type GlobalOptions } from './command-support.js';
import { accountRoot, environmentsOf, findAccount, rcLabel } from './config/accounts.js';
import { editConfigFile } from './config/edit.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { DevhostError, HumanActionRequired, UsageError } from './errors.js';
import { bootstrapDaemon, daemonState, stopDaemon } from './launchd.js';
import { acceptWorkspace, authStatus, type LoginContext } from './login.js';
import { makePrompter } from './prompter.js';
import type { Executor } from './runner/executor.js';
import { readState, writeState } from './state.js';
import { buildSteps, selectSteps } from './steps/index.js';
import { isMountPoint, mountPointFor } from './storage/mount.js';
import { AUTODISKMOUNT, passphraseStored, setPassphrase, UNLOCK_LABEL, unlockPlistInstalled } from './storage/root.js';
import { readSecret } from './storage/secret.js';
import { listExternal, MARKER, onVolume, volumeInfo, volumeStatus, workVolumeOf } from './storage/volume.js';

type Volume = NonNullable<StorageStatusData['volume']>;

/** Everything `storage status`, doctor and the app show about the configured volume. */
export async function storageStatus(exec: Executor, config: DevhostConfig, home?: string): Promise<StorageStatusData> {
  const v = workVolumeOf(config);
  if (!v) return { configured: false };
  const migrated = home ? (await readState(exec, home)).migrated ?? {} : {};
  const oldCopies = Object.entries(migrated).map(([account, path]) => ({ account, path }));
  const s = await volumeStatus(exec, v);
  const spotlight = s.ready ? await exec.query('mdutil', ['-s', s.mountPoint]) : null;
  const automount = await exec.query('defaults', ['read', AUTODISKMOUNT, 'AutomountDisksWithoutUserLogin']);
  const volume: Volume = {
    ...s,
    root: v.root,
    encryptedInConfig: v.encrypted === true,
    spotlightOff: spotlight ? /disabled/i.test(spotlight.stdout) : null,
    automountWithoutLogin: automount.code === 0 && /^(1|true|YES)$/i.test(automount.stdout.trim()),
    unlockDaemon: (await unlockPlistInstalled(exec)) && (await daemonState(exec, UNLOCK_LABEL)).loaded,
    passphraseStored: v.encrypted === true ? await passphraseStored(exec) : false,
  };
  return { configured: true, volume, ...(oldCopies.length ? { oldCopies } : {}) };
}

const gb = (n: number | null): string => (n === null ? '?' : `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`);
const yes = (b: boolean | null | undefined): string => (b == null ? '?' : b ? 'yes' : 'no');

export function storageStatusCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<StorageStatusData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const data = await storageStatus(exec, config, deps.home);
    const v = data.volume;
    const human = !v
      ? 'No work volume configured (storage.workVolume). Everything is on the internal disk. `devhost storage list` shows external disks.'
      : [
          `${v.label} (${v.uuid}) at ${v.mountPoint}: ${v.ready ? 'ready' : v.mounted ? 'mounted, but not the configured volume' : 'not mounted'}`,
          `  uuid match ${yes(v.uuidMatch)} · marker ${yes(v.markerMatch)} · APFS ${yes(v.apfs)} · encrypted ${yes(v.encrypted)}${v.locked ? ' (locked)' : ''} · ownership ${yes(v.ownership)}`,
          `  free ${gb(v.freeBytes)} of ${gb(v.totalBytes)} · Spotlight ${v.spotlightOff === null ? '?' : v.spotlightOff ? 'off' : 'on'} · mounts without login ${yes(v.automountWithoutLogin)}${v.encryptedInConfig ? ` · unlock service ${yes(v.unlockDaemon)} · passphrase stored ${yes(v.passphraseStored)}` : ''}`,
          ...(v.doubleMount ? [`  ⚠ ${v.mountPoint} 1 exists: the volume is mounted a second time`] : []),
          ...(v.strayDirectory ? [`  ⚠ ${v.mountPoint} is a plain directory on the internal disk, not the volume`] : []),
        ].join('\n');
    return { data, human, exit: v && !v.ready ? 1 : 0 };
  });
}

/** `storage wait`: exit 0 only once the configured volume is mounted, uuid and marker match. Creates nothing. */
export async function storageWaitCommand(deps: Deps, g: GlobalOptions, timeoutSeconds: number): Promise<number> {
  return short<StorageStatusData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const v = workVolumeOf(config);
    if (!v) return { data: { configured: false }, human: 'No work volume configured: nothing to wait for.' };
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const deadline = deps.now().getTime() + timeoutSeconds * 1000;
    for (;;) {
      const data = await storageStatus(exec, config);
      if (data.volume!.ready) return { data, human: `${v.label} is ready.` };
      if (deps.now().getTime() >= deadline || deps.cancel.cancelled) {
        throw new DevhostError(`the work volume ${v.label} is not ready after ${timeoutSeconds} s`, 'volume-not-ready', 1, 'devhost storage status');
      }
      await exec.sleep(2000);
    }
  });
}

export function storageListCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<StorageListData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, newReporter(deps, g), false);
    const adopted = workVolumeOf(config)?.uuid.toUpperCase();
    const disks = (await listExternal(exec)).map((d) => ({ ...d, volumes: d.volumes.map((v) => ({ ...v, ...(v.uuid === adopted ? { adopted: true } : {}) })) }));
    const human = disks.length === 0
      ? 'No external disks.'
      : disks.map((d) => [`${d.device}  ${d.model || 'disk'}  ${gb(d.sizeBytes)}`, ...d.volumes.map((v) => `  ${v.device}  ${v.name}  ${v.uuid}  ${v.mountPoint ?? 'not mounted'}${v.uuid === adopted ? '  ← work volume' : ''}`)].join('\n')).join('\n');
    return { data: { disks }, human };
  });
}

export interface AdoptOptions {
  volume: string;
  root?: string;
}

/** `storage adopt <volume>`: an existing external APFS volume becomes the work volume (config + marker file). */
export function storageAdoptCommand(deps: Deps, g: GlobalOptions, o: AdoptOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const exec = newExecutor(deps, g, reporter, false);
    const info = await volumeInfo(exec, o.volume);
    if (!info) throw new UsageError(`diskutil does not know "${o.volume}"`, 'See `devhost storage list` (a device like disk4s1, a mount point, or a volume UUID).');
    if (!info.apfs) throw new UsageError(`${info.name || info.device} is not APFS`, 'Erase it as APFS first (devhost storage prepare <disk>, destructive), or pick an APFS volume.');
    if (info.internal) throw new UsageError(`${info.name || info.device} is on an internal disk`, 'The work volume is an external disk.');
    const mountPoint = mountPointFor(info.name);
    if (info.mountPoint !== mountPoint || !isMountPoint(mountPoint)) throw new UsageError(`${info.name} is not mounted at ${mountPoint}`, info.locked ? 'Unlock it first (diskutil apfs unlockVolume).' : 'Mount it first (diskutil mount).');
    const current = workVolumeOf(config);
    if (current && current.uuid.toUpperCase() !== info.uuid) throw new UsageError(`another work volume is configured (${current.label}, ${current.uuid})`, 'devhost supports one work volume. Remove storage.workVolume from the config first.');

    // Resolved first: `/Volumes/x/../../etc` starts with the mount point and is not on it.
    if (o.root !== undefined && !/^(\/|~\/)/.test(o.root)) throw new UsageError(`${o.root} is not an absolute path`, `Give a root under ${mountPoint}/.`);
    const root = resolve(o.root ?? current?.root ?? `${mountPoint}/work`);
    if (!root.startsWith(`${mountPoint}/`)) throw new UsageError(`${root} is not on ${mountPoint}`, `Give a root under ${mountPoint}/.`);
    exec.beginStep('storage.adopt');
    reporter.step('storage.adopt', 'start', `${info.name} (${info.uuid})`);
    await exec.writeText(join(mountPoint, MARKER), `${info.uuid}\n`, { description: `mark ${mountPoint} as the work volume` });
    await exec.mkdirp(root);
    const entry = { label: info.name, uuid: info.uuid, encrypted: info.encrypted, root, spotlight: current?.spotlight ?? false, alerts: current?.alerts ?? { freePercent: 15 } };
    const notes: string[] = [];
    await editConfigFile(g.configPath, deps.now(), (doc) => {
      doc.setIn(['storage', 'workVolume'], entry);
      // The Colima VM disk stays internal: on a small internal disk, a smaller default (spec A7.12).
      if ((config.docker?.diskGiB ?? 200) === 200 && config.docker?.runtime === 'colima') {
        doc.setIn(['docker', 'diskGiB'], 80);
        notes.push('docker.diskGiB lowered from 200 to 80 (the Colima VM disk stays on the internal disk). An existing Colima disk does not shrink.');
      }
    });
    reporter.step('storage.adopt', 'changed', `root ${root}`);
    notes.push('New accounts land on the volume; move an existing one with `devhost storage migrate --account <name>`.', 'Run `devhost apply` for the volume settings (ownership, Spotlight, mount at boot, unlock).');
    const data: StorageChangeData = { action: 'adopted', label: info.name, uuid: info.uuid, root, notes };
    return { ok: true, data, human: ['', `✅ ${info.name} is the work volume (${info.uuid}).`, ...notes.map((n) => `   ${n}`)] };
  });
}

/** `storage set-passphrase`: from stdin only, into the System keychain. */
export function storageSetPassphraseCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const v = workVolumeOf(config);
    if (!v) throw new UsageError('no work volume configured', 'devhost storage adopt <volume>');
    const pass = await readSecret(deps, 'Work volume passphrase: ');
    const exec = newExecutor(deps, g, reporter, false);
    exec.beginStep('storage.passphrase');
    reporter.step('storage.passphrase', 'start', 'store it in the System keychain');
    await setPassphrase(exec, pass);
    reporter.step('storage.passphrase', 'changed');
    return { ok: true, data: { action: 'passphrase-set', label: v.label, uuid: v.uuid } satisfies StorageChangeData, human: ['', '✅ The passphrase is in the System keychain. `devhost apply` installs the unlock service.'] };
  });
}

export interface PrepareOptions {
  disk: string;
  label: string;
  encrypted: boolean;
  yesErase: boolean;
}

/**
 * `storage prepare <disk>`: erase an external disk as APFS (encrypted when asked), then adopt it.
 * Destructive; CLI only: needs --yes-erase and the disk identifier typed back.
 */
export function storagePrepareCommand(deps: Deps, g: GlobalOptions, o: PrepareOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    await loadConfig(g.configPath);
    if (!/^disk\d+$/.test(o.disk)) throw new UsageError(`"${o.disk}" is not a whole disk identifier`, 'Give the whole disk, like disk4 (see `devhost storage list`).');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/.test(o.label)) throw new UsageError(`"${o.label}" is not a volume name`, 'Letters, digits, dot, dash and underscore.');
    const exec = newExecutor(deps, g, reporter, false);
    const disk = (await listExternal(exec)).find((d) => d.device === o.disk);
    if (!disk) throw new UsageError(`${o.disk} is not an external physical disk`, 'See `devhost storage list`. Internal disks are never erased.');
    const what = `${disk.device} ${disk.model || 'disk'} ${gb(disk.sizeBytes)}; volumes: ${disk.volumes.map((v) => `${v.name} (${v.mountPoint ?? 'not mounted'})`).join(', ') || 'none'}`;
    reporter.log('warn', `ERASES ${what}`);
    if (!o.yesErase) throw new UsageError('erasing needs --yes-erase', `It destroys everything on ${what}.`);
    const prompter = makePrompter(deps, g.json, false);
    const typed = await prompter.input('confirm-disk', `Type ${o.disk} to erase it:`);
    if (typed.trim() !== o.disk) throw new HumanActionRequired('not confirmed; nothing was erased', `Type exactly ${o.disk}.`);
    const pass = o.encrypted ? await readSecret(deps, 'Passphrase for the new volume: ') : null;

    exec.beginStep('storage.prepare');
    reporter.step('storage.prepare', 'start', `erase ${o.disk} as APFS "${o.label}"`);
    await exec.exec('diskutil', ['eraseDisk', 'APFS', o.label, 'GPT', o.disk], { progress: true });
    const info = await volumeInfo(exec, mountPointFor(o.label));
    if (!info) throw new DevhostError(`the new volume ${o.label} did not appear`, 'volume-missing', 1, 'devhost storage list');
    if (pass !== null) {
      await exec.exec('diskutil', ['apfs', 'encryptVolume', info.device, '-user', 'disk', '-stdinpassphrase'], { input: `${pass}\n` });
      await setPassphrase(exec, pass);
    }
    reporter.step('storage.prepare', 'changed', `${o.label} (${info.uuid})`);
    return { ok: true, data: { action: 'prepared', label: o.label, uuid: info.uuid } satisfies StorageChangeData, human: ['', `✅ ${o.disk} is APFS "${o.label}" (${info.uuid}). Next: devhost storage adopt ${info.uuid}`] };
  });
}

/** Files and bytes under a directory (lstat: links are counted, not followed). */
async function tally(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        files++;
        bytes += (await lstat(p)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

export interface MigrateOptions {
  account: string;
  cleanup: boolean;
  dryRun: boolean;
}

/**
 * `storage migrate --account <a>`: move an account root onto the work volume. Stops only that
 * account's services, copies (rsync -aH), verifies, points the config at the copy, regenerates what
 * names the path (.envrc, includeIf, plists, Colima mounts) and re-accepts workspace trust. The
 * old copy stays until `--cleanup`.
 */
export function storageMigrateCommand(deps: Deps, g: GlobalOptions, o: MigrateOptions): Promise<number> {
  return long(deps, g, async (reporter) => {
    const { config } = await loadConfig(g.configPath);
    const v = workVolumeOf(config);
    if (!v) throw new UsageError('no work volume configured', 'devhost storage adopt <volume>');
    const account = findAccount(config, o.account);
    if (!account) throw new UsageError(`no account named "${o.account}"`);
    const exec = newExecutor(deps, g, reporter, o.dryRun);
    let files = 0;
    let bytes = 0;
    const prompter = makePrompter(deps, g.json, g.yes);
    const state = await readState(exec, deps.home);
    const migrated = state.migrated ?? {};

    if (o.cleanup) {
      const old = migrated[o.account];
      if (!old) throw new UsageError(`no earlier copy of ${o.account} is recorded`, 'Cleanup removes the old copy after `storage migrate`.');
      if (onVolume(v, old) || old === accountRoot(account, deps.home)) throw new DevhostError(`refusing to remove ${old}: it is the account's root`, 'cleanup-refused', 1);
      exec.beginStep('storage.cleanup');
      if (!o.dryRun && !(await prompter.confirm('cleanup-old-root', `Delete the old copy ${old}?`))) {
        return { ok: false, data: null, error: new DevhostError('not confirmed; nothing was deleted', 'not-confirmed') };
      }
      await exec.remove(old, { recursive: true });
      if (!o.dryRun) await writeState(exec, deps.home, { ...state, migrated: Object.fromEntries(Object.entries(migrated).filter(([k]) => k !== o.account)) });
      return { ok: true, data: { action: 'cleaned-up', account: o.account, from: old } satisfies StorageChangeData, human: ['', `✅ Removed ${old}.`] };
    }

    const from = accountRoot(account, deps.home);
    const to = `${v.root}/${o.account}`;
    if (onVolume(v, from)) throw new UsageError(`${o.account} is on the work volume already (${from})`);
    const vs = await volumeStatus(exec, v);
    if (!vs.ready) throw new HumanActionRequired(`the work volume is not ready (${vs.mountPoint})`, 'devhost storage status');
    const envs = environmentsOf(config).filter((e) => e.account === o.account);
    const notes = [
      'Claude Code keeps session history by project path: earlier sessions of these environments stay listed under the old path and do not follow the move.',
      'Remote Control sessions of the old paths end; the services register again from the new paths.',
      `The old copy stays at ${from} until: devhost storage migrate --account ${o.account} --cleanup`,
    ];
    reporter.log('warn', notes[0]!);
    if (!o.dryRun && !(await prompter.confirm('migrate-account', `Move ${o.account} from ${from} to ${to}? Its services stop meanwhile.`))) {
      return { ok: false, data: null, error: new DevhostError('not confirmed; nothing was changed', 'not-confirmed') };
    }

    exec.beginStep('storage.migrate.stop');
    reporter.step('storage.migrate.stop', 'start', `stop ${o.account}'s services`);
    const stopped: string[] = [];
    for (const e of envs) {
      const label = rcLabel(o.account, e.name);
      if (!(await daemonState(exec, label)).loaded) continue;
      stopped.push(label);
      await stopDaemon(exec, label, `stop ${e.name} while it moves`);
    }
    reporter.step('storage.migrate.stop', 'ok');

    try {
      exec.beginStep('storage.migrate.copy');
      reporter.step('storage.migrate.copy', 'start', `rsync -aH ${from}/ ${to}/`);
      await exec.mkdirp(to);
      await exec.exec('rsync', ['-aH', `${from}/`, `${to}/`], { progress: true });
      if (!o.dryRun) {
        const a = await tally(from);
        const b = await tally(to);
        if (a.files !== b.files || a.bytes !== b.bytes) {
          throw new DevhostError(`the copy differs: ${a.files} files / ${a.bytes} bytes at ${from}, ${b.files} / ${b.bytes} at ${to}`, 'migrate-verify-failed', 1, 'Nothing was switched; the old root is untouched. Fix the cause and run migrate again.');
        }
        ({ files, bytes } = a);
      }
    } catch (err) {
      // The config still points at the old root: what was stopped for the move runs again from it.
      for (const label of stopped) {
        try {
          await bootstrapDaemon(exec, label, `start ${label} again (the move failed)`);
        } catch (restartErr) {
          reporter.log('warn', `could not start ${label} again: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`);
        }
      }
      throw err;
    }
    reporter.step('storage.migrate.copy', 'changed', `${files} files, ${gb(bytes)}`);

    exec.beginStep('storage.migrate.config');
    let next = config;
    if (!o.dryRun) {
      ({ config: next } = await editConfigFile(g.configPath, deps.now(), (doc) => {
        const i = (config.accounts ?? []).findIndex((x) => x.name === o.account);
        doc.setIn(['accounts', i, 'root'], to);
      }));
      await writeState(exec, deps.home, { ...state, migrated: { ...migrated, [o.account]: from } });
    }
    reporter.step('storage.migrate.config', o.dryRun ? 'ok' : 'changed', `root ${to}`);

    // What names the path: .envrc, includeIf, the services' plists (and trust), Colima's mounts.
    const loggedIn = (await authStatus({ exec, deps }, account)).loggedIn === true;
    const loginCtx: LoginContext = {
      deps, config: next, account: findAccount(next, o.account) ?? account, exec, reporter, prompter,
      interactive: deps.stdinIsTTY && !g.json,
      stepContext: () => newStepContext(deps, g, next, exec),
    };
    const ctx = newStepContext(deps, g, next, exec, {
      onlyAccount: o.account,
      beforeService: async (info) => {
        if (!loggedIn) return;
        reporter.step(`trust.${info.name}`, 'start', info.dir);
        const ok = await acceptWorkspace(loginCtx, info);
        reporter.step(`trust.${info.name}`, ok ? 'ok' : 'skipped', ok ? undefined : 'not trusted; run `devhost login ' + o.account + '`');
      },
    });
    const outcome = await runSteps(selectSteps(buildSteps(next), ['accounts.routing', 'accounts.git', 'docker.runtime', ...envs.map((e) => `env.${e.name}`)]), ctx, reporter, deps.cancel);
    const data: StorageChangeData = { action: 'migrated', account: o.account, from, to, files, bytes, environments: envs.map((e) => e.name), notes, ...(o.dryRun ? { dryRun: true, plan: exec.plan as never } : {}) };
    return { ok: outcome.error === null, data, error: outcome.error, cancelled: outcome.cancelled, human: ['', `✅ ${o.account} moved to ${to} (${files} files, ${gb(bytes)}).`, ...notes.map((n) => `   ${n}`)] };
  });
}

