import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Deps } from '../src/deps.js';
import { main } from '../src/main.js';
import { MockRunner } from '../src/runner/mock.js';

export interface TestEnv {
  home: string;
  deps: Deps;
  runner: MockRunner;
  out: string[];
  err: string[];
  stdout(): string;
  run(...argv: string[]): Promise<number>;
}

export async function makeEnv(runner = new MockRunner(), tty = false): Promise<TestEnv> {
  const home = await mkdtemp(join(tmpdir(), 'devhost-test-'));
  process.env['DEVHOST_LAUNCHD_DIR'] = join(home, 'LaunchDaemons');
  process.env['DEVHOST_ROOT_HELPER_DIR'] = join(home, 'PrivilegedHelperTools');
  process.env['DEVHOST_VOLUMES_DIR'] = join(home, 'Volumes');
  mkdirSync(join(home, 'Volumes'), { recursive: true });
  runner.context['home'] = home;
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    stdin: process.stdin,
    stdinIsTTY: tty,
    stdoutIsTTY: false,
    // Claude Code makes an answer wait (login.ts ANSWER_AFTER_MS); the fake needs no pause.
    env: { DEVHOST_TRUST_ANSWER_MS: '0' },
    home,
    user: 'tester',
    brewPrefix: '/opt/homebrew',
    nodePath: '/opt/homebrew/bin/node',
    runner,
    now: () => new Date(2026, 9, 12, 20, 30, 15),
    cancel: { cancelled: false },
  };
  return {
    home,
    deps,
    runner,
    out,
    err,
    stdout: () => out.join(''),
    run: (...argv) => main(argv, deps),
  };
}

export function ndjson(text: string): unknown[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

const strip = (line: string): string => line.replace(/^sudo (-n )?-- /, '');

export interface FakeVolume {
  uuid: string;
  name: string;
  device: string;
  mountPoint: string | null;
  apfs?: boolean;
  encrypted?: boolean;
  locked?: boolean;
  ownership?: boolean;
  internal?: boolean;
  totalBytes?: number;
  freeBytes?: number;
}

const plistValue = (v: unknown): string =>
  v === true ? '<true/>' : v === false ? '<false/>' : typeof v === 'number' ? `<integer>${v}</integer>`
  : Array.isArray(v) ? `<array>${v.map(plistValue).join('')}</array>`
  : v && typeof v === 'object' ? `<dict>${Object.entries(v).map(([k, x]) => `<key>${k}</key>${plistValue(x)}`).join('')}</dict>`
  : `<string>${String(v ?? '')}</string>`;
export const plistXml = (v: unknown): string => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${plistValue(v)}\n</plist>\n`;

/** Mount (or unmount) a fake volume: its directory under the test /Volumes, with the test-mode mount marker. */
export function mountVolume(volumesDir: string, v: FakeVolume, mounted: boolean): void {
  const dir = join(volumesDir, v.name);
  if (mounted) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.test-mounted'), '');
    v.mountPoint = dir;
  } else {
    rmSync(join(dir, '.test-mounted'), { force: true });
    v.mountPoint = null;
  }
}

export interface FakeState {
  /** Called when a LaunchDaemon is loaded (a test can play the service starting). */
  onBootstrap?: (label: string) => void;
  names: { ComputerName: string; HostName: string; LocalHostName: string };
  power: Record<string, number>;
  sshOn: boolean;
  bundled: Set<string>;
  mise: Map<string, string>;
  /** mise from its installer (~/.local/bin/mise), not on PATH. */
  miseInstalled: boolean;
  /** Binaries on PATH. `brew bundle` installs the usual set. */
  binaries: Set<string>;
  /** LaunchDaemon labels currently loaded (and therefore running). */
  loaded: Set<string>;
  colimaRunning: boolean;
  tailscale: string | null;
  direnvAllowed: Set<string>;
  /** Directories that exist (besides the real filesystem). */
  dirs: Set<string>;
  /** Logged-in config dirs; the default account is 'default'. */
  loggedIn: Set<string>;
  /** Who each config dir is signed in as (`claude auth status` email), and who the next `auth login` signs in. */
  identities?: Map<string, string>;
  loginAs?: string;
  /** Repositories (by directory) that have a commit; a clone has one unless its remote is in emptyRemotes. */
  commits?: Set<string>;
  emptyRemotes?: Set<string>;
  /** Keychain items by service (`security find-generic-password -s <service> -w`). */
  keychain?: Map<string, string>;
  /** External volumes diskutil knows (mounted ones also need their mount directory, see mountVolume). */
  volumes?: FakeVolume[];
  /** Mount points with Spotlight off; AutomountDisksWithoutUserLogin; the System keychain's work volume passphrase. */
  spotlightOff?: Set<string>;
  automount?: boolean;
  volumePassphrase?: string;
  /** What a container sees in a bind mount from the work volume (false: an empty directory, Colima without the mount). */
  colimaSeesVolume?: boolean;
  composeUp: Set<string>;
  /** A one-shot init container that ran to completion next to the running ones. */
  composeInit?: boolean;
  /** Output of `git log --branches --not --remotes --oneline` per directory. */
  unpushed: Map<string, string>;
  uninstalled: string[];
  fileVault: 'On' | 'Off';
  /** `uname -m`; Homebrew lives in /opt/homebrew (arm64) or /usr/local (x86_64). */
  arch: 'arm64' | 'x86_64';
  /** The CLI's node runs under Rosetta (`sysctl.proc_translated` is 1). */
  rosetta: boolean;
  /** A laptop: `pmset -g cap` has no autorestart. */
  laptop: boolean;
  /** Keys `pmset -a` accepts but silently ignores (as macOS does for settings a Mac lacks). */
  pmsetIgnores: string[];
  /** `sudo -n` fails because a password is needed (no cached sudo, no terminal). */
  sudoNeedsPassword: boolean;
  /** `claude --version`; `brew upgrade --cask claude-code` moves it to claudeLatest. */
  claudeVersion: string;
  /** The cask's version in `brew info` (default 2.1.300). */
  claudeLatest?: string;
  /** `brew outdated --json=v2` output. */
  outdated?: { formulae: unknown[]; casks: unknown[] };
  /** `ps -axo …` lines (pid ppid pcpu rss command); a `launchctl kickstart -k` ends the children of pid 4242. */
  procs?: string[];
  /** Commands `brew upgrade` ran with (formulae and casks). */
  upgraded?: string[];
  /** The fake claude acknowledges the trust question but does not record it (it stopped, or lost the write). */
  claudeForgetsTrust: boolean;
  /** What a `claude -p --resume <id> --fork-session` answers (handoff notes), per session id. */
  forks?: Record<string, string>;
  /** The `claude -p` fork commands run. */
  forked?: string[];
}

const BREWED = ['git', 'claude', 'colima', 'docker', 'tailscale', 'direnv', 'curl'];

/**
 * A stateful stand-in for a Mac: answers read-only commands from its state and
 * updates the state on the matching mutating commands. Lets tests prove that a
 * second `apply` changes nothing. LaunchDaemon plists are really written to
 * DEVHOST_LAUNCHD_DIR (a temp dir set by makeEnv).
 */
export function fakeMac(initial: Partial<FakeState> = {}): { runner: MockRunner; state: FakeState } {
  const state: FakeState = {
    names: { ComputerName: 'old', HostName: 'old', LocalHostName: 'old' },
    power: { sleep: 1, disksleep: 10, autorestart: 0, womp: 0 },
    sshOn: false,
    bundled: new Set(),
    mise: new Map(),
    binaries: new Set(['node']),
    loaded: new Set(),
    colimaRunning: false,
    tailscale: null,
    direnvAllowed: new Set(),
    dirs: new Set(),
    loggedIn: new Set(),
    composeUp: new Set(),
    unpushed: new Map(),
    uninstalled: [],
    fileVault: 'On',
    arch: 'arm64',
    rosetta: false,
    laptop: false,
    pmsetIgnores: [],
    sudoNeedsPassword: false,
    claudeVersion: '2.1.300',
    claudeForgetsTrust: false,
    miseInstalled: false,
    ...initial,
  };
  const brewBin = (): string => (state.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin');
  const runner = new MockRunner();
  const dispatch = (call: { command: string; args: string[]; opts?: { env?: Record<string, string>; cwd?: string; input?: string } }) => {
    if (state.sudoNeedsPassword && call.command === 'sudo' && call.args[0] === '-n') return { code: 1, stderr: 'sudo: a password is required\n' };
    // mise from its installer runs by absolute path (~/.local/bin is not on ssh's PATH).
    const line = strip([call.command, ...call.args].join(' ')).replace(/^\/\S+\/\.local\/bin\/mise /, 'mise ');
    let m: RegExpExecArray | null;
    if (line === 'sh -c curl -fsSL https://mise.run | sh') {
      state.miseInstalled = true;
      return {};
    }
    if (/^test -x \/\S+\/\.local\/bin\/mise$/.test(line)) return { code: state.miseInstalled ? 0 : 1 };
    if (line.startsWith('mise ') && !state.miseInstalled) return { code: 127, stderr: 'command not found: mise\n' };
    if ((m = /^scutil --get (\w+)$/.exec(line))) {
      return { stdout: `${state.names[m[1] as keyof FakeState['names']]}\n` };
    }
    if ((m = /^scutil --set (\w+) (\S+)$/.exec(line))) {
      state.names[m[1] as keyof FakeState['names']] = m[2]!;
      return {};
    }
    if (line === 'pmset -g cap') {
      const caps = ['displaysleep', 'disksleep', 'sleep', 'womp', ...(state.laptop ? ['lidwake'] : ['autorestart'])];
      return { stdout: `Capabilities for AC Power:\n${caps.map((c) => ` ${c}\n`).join('')}` };
    }
    if (line === 'pmset -g custom') {
      const autorestart = state.laptop ? '' : ` autorestart          ${state.power['autorestart']}\n`;
      return {
        stdout: `Battery Power:\nAC Power:\n sleep                ${state.power['sleep']} (sleep prevented by powerd)\n disksleep            ${state.power['disksleep']}\n womp                 ${state.power['womp']}\n${autorestart}`,
      };
    }
    if (line.startsWith('pmset -a ')) {
      const parts = line.split(' ').slice(2);
      const ignored = state.laptop ? [...state.pmsetIgnores, 'autorestart'] : state.pmsetIgnores;
      for (let i = 0; i < parts.length; i += 2) if (!ignored.includes(parts[i]!)) state.power[parts[i]!] = Number(parts[i + 1]);
      return {};
    }
    if (line.startsWith('nc -z')) return { code: state.sshOn ? 0 : 1 };
    if (line === 'systemsetup -setremotelogin on') {
      state.sshOn = true;
      return {};
    }
    if ((m = /^brew install (\S+)$/.exec(line))) {
      state.binaries.add(m[1]!);
      return {};
    }
    if (line.startsWith('brew bundle check')) return { code: state.bundled.has('all') ? 0 : 1 };
    if (line.startsWith('brew bundle')) {
      state.bundled.add('all');
      BREWED.forEach((b) => state.binaries.add(b));
      return {};
    }
    if (line === 'brew services start tailscale') {
      state.tailscale = 'NeedsLogin';
      return {};
    }
    if (line === 'tailscale status --json --peers=false') {
      return state.tailscale === null ? { code: 1, stderr: 'failed to connect to local tailscaled' } : { stdout: JSON.stringify({ BackendState: state.tailscale }) };
    }
    if (line === 'mise ls --global --json') {
      const obj: Record<string, unknown[]> = {};
      for (const [tool, version] of state.mise) obj[tool] = [{ requested_version: version, installed: true }];
      return { stdout: JSON.stringify(obj) };
    }
    if (line.startsWith('mise use --global --yes ')) {
      for (const spec of line.split(' ').slice(4)) {
        const [tool, version] = spec.split('@');
        state.mise.set(tool!, version!);
      }
      return {};
    }
    if ((m = /^sh -c command -v (\S+)$/.exec(line))) {
      return state.binaries.has(m[1]!) ? { stdout: `${brewBin()}/${m[1]}\n` } : { code: 1 };
    }
    if ((m = /^launchctl print system\/(\S+)$/.exec(line))) {
      return state.loaded.has(m[1]!) ? { stdout: 'state = running\n\tpid = 4242\n' } : { code: 113, stderr: 'Could not find service' };
    }
    if ((m = /^launchctl bootstrap system (\S+)$/.exec(line))) {
      const label = basename(m[1]!, '.plist');
      state.loaded.add(label);
      state.onBootstrap?.(label);
      if (label === 'com.devhost.colima') state.colimaRunning = true;
      return {};
    }
    if ((m = /^launchctl bootout system\/(\S+)$/.exec(line))) {
      state.loaded.delete(m[1]!);
      if (m[1] === 'com.devhost.colima') state.colimaRunning = false;
      return {};
    }
    if (line.startsWith('launchctl kickstart')) {
      if (line.includes(' -k ')) state.procs = (state.procs ?? []).filter((p) => !/^\s*\d+\s+4242\s/.test(p));
      return {};
    }
    if ((m = /^install -m 644 -o root -g wheel (\S+) (\S+)$/.exec(line))) {
      mkdirSync(dirname(m[2]!), { recursive: true });
      copyFileSync(m[1]!, m[2]!);
      return {};
    }
    if ((m = /^rm -f (\S+)$/.exec(line))) {
      rmSync(m[1]!, { force: true });
      return {};
    }
    if (line === 'colima status') return { code: state.colimaRunning ? 0 : 1 };
    if (line === 'colima stop') {
      state.colimaRunning = false;
      return {};
    }
    if ((m = /^test -d (.+)$/.exec(line))) return { code: existsSync(m[1]!) || state.dirs.has(m[1]!) ? 0 : 1 };
    if (line === 'direnv status') {
      const cwd = call.command === 'direnv' ? (runner.calls.at(-1)?.opts?.cwd ?? '') : '';
      return { stdout: state.direnvAllowed.has(cwd) ? 'Found RC allowed 0\n' : 'Found RC allowed 2\n' };
    }
    if ((m = /^direnv allow (\S+)$/.exec(line))) {
      state.direnvAllowed.add(m[1]!);
      return {};
    }
    const key = call.opts?.env?.['CLAUDE_CONFIG_DIR'] ?? 'default';
    if (line === `${brewBin()}/claude auth status`) {
      const email = state.identities?.get(key);
      return { code: state.loggedIn.has(key) ? 0 : 1, stdout: email ? JSON.stringify({ loggedIn: true, email, orgId: `org-of-${email}` }) : '{}' };
    }
    if (line === `${brewBin()}/claude auth logout`) {
      state.loggedIn.delete(key);
      return {};
    }
    if ((m = /^git init (\S+)$/.exec(line))) {
      mkdirSync(join(m[1]!, '.git', 'info'), { recursive: true });
      return {};
    }
    if ((m = /^git clone -- (\S+) (\S+)$/.exec(line))) {
      mkdirSync(join(m[2]!, '.git', 'info'), { recursive: true });
      if (!state.emptyRemotes?.has(m[1]!)) (state.commits ??= new Set()).add(m[2]!);
      return {};
    }
    if ((m = /^git -C (\S+) rev-parse --git-dir$/.exec(line))) return { code: existsSync(join(m[1]!, '.git')) ? 0 : 128 };
    if ((m = /^git -C (\S+) rev-parse --verify --quiet HEAD$/.exec(line))) return { code: existsSync(join(m[1]!, '.git')) && (state.commits ??= new Set()).has(m[1]!) ? 0 : 1 };
    if ((m = /^git -C (\S+) commit --allow-empty --quiet -m Initial commit$/.exec(line))) {
      (state.commits ??= new Set()).add(m[1]!);
      return {};
    }
    if ((m = /^git -C (\S+) log --branches --not --remotes --oneline$/.exec(line))) return { stdout: state.unpushed.get(m[1]!) ?? '' };
    if ((m = /^git -C (\S+) status --porcelain$/.exec(line))) return { stdout: '' };
    if ((m = /^docker compose -p (\S+) up -d$/.exec(line))) {
      state.composeUp.add(m[1]!);
      return {};
    }
    if ((m = /^docker compose -p (\S+) down$/.exec(line))) {
      state.composeUp.delete(m[1]!);
      return {};
    }
    if ((m = /^docker compose -p (\S+) ps --format \{\{\.Service\}\} \{\{\.State\}\}$/.exec(line))) return { stdout: state.composeUp.has(m[1]!) ? 'db running\n' : '' };
    if ((m = /^docker compose -p (\S+) stop /.exec(line))) {
      state.composeUp.delete(m[1]!);
      return {};
    }
    if ((m = /^docker compose -p (\S+) start /.exec(line))) {
      state.composeUp.add(m[1]!);
      return {};
    }
    if ((m = /^docker compose -p (\S+) ps -a --format/.exec(line))) return { stdout: state.composeUp.has(m[1]!) ? (state.composeInit ? 'running 0\nexited 0\n' : 'running 0\n') : '' };
    if (line === 'sw_vers -productVersion') return { stdout: '26.0\n' };
    if (line === 'uname -m') return { stdout: `${state.arch}\n` };
    if (line === 'sysctl -n sysctl.proc_translated') return state.rosetta ? { stdout: '1\n' } : { code: 1, stderr: 'unknown oid\n' };
    if (line === 'fdesetup status') return { stdout: `FileVault is ${state.fileVault}.\n` };
    if (line === 'brew --version') return { stdout: 'Homebrew 5.0.0\n' };
    if (line.startsWith('df -k /')) return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 1000000 500000 500000 50% /\n' };
    if (line.startsWith('docker info')) return state.colimaRunning ? { stdout: '27.0\n' } : { code: 1 };
    if (line === `${brewBin()}/claude --version`) return { stdout: `${state.claudeVersion} (Claude Code)\n` };
    if (line === 'brew upgrade --cask claude-code') {
      state.claudeVersion = state.claudeLatest ?? '2.1.300';
      return {};
    }
    if (line === 'brew update --quiet') return {};
    if (line === 'brew info --json=v2 --cask claude-code') return { stdout: JSON.stringify({ formulae: [], casks: [{ token: 'claude-code', version: state.claudeLatest ?? '2.1.300' }] }) };
    if (line === 'brew outdated --json=v2') return { stdout: JSON.stringify(state.outdated ?? { formulae: [], casks: [] }) };
    if (line.startsWith('brew upgrade ')) {
      (state.upgraded ??= []).push(line.slice('brew upgrade '.length));
      return {};
    }
    if (line === 'ps -axo pid=,ppid=,pcpu=,rss=,command=') return { stdout: (state.procs ?? []).join('\n') };
    if (line === 'ps -axo command=') return { stdout: (state.procs ?? []).map((p) => p.replace(/^\s*\d+\s+\d+\s+\S+\s+\d+\s+/, '')).join('\n') };
    const fork = new RegExp(`^${brewBin()}/claude -p --resume (\\S+) --fork-session`).exec(line);
    if (fork) {
      (state.forked ??= []).push(fork[1]!);
      const note = state.forks?.[fork[1]!];
      return note ? { stdout: note } : { code: 1, stderr: 'No conversation found with session ID' };
    }
    if (line === `${brewBin()}/claude doctor`) return { stdout: 'Remote Control: available\n' };
    if (line.startsWith('curl -s -m 2 http://127.0.0.1:')) return state.loaded.has('com.devhost.collector') ? { stdout: '{"ok":true}' } : { code: 7 };
    if (line.startsWith('du -sk')) return { stdout: '64\t/x\n' };
    if ((m = /^direnv exec (\S+) sh -c printenv CLAUDE_CONFIG_DIR$/.exec(line))) {
      const rc = existsSync(join(m[1]!, '.envrc')) ? readFileSync(join(m[1]!, '.envrc'), 'utf8') : '';
      return { stdout: /export CLAUDE_CONFIG_DIR=(\S+)/.exec(rc)?.[1] ? `${/export CLAUDE_CONFIG_DIR=(\S+)/.exec(rc)![1]}\n` : '' };
    }
    if ((m = /^git -C (\S+) config --get user\.email$/.exec(line))) {
      const home = runner.context['home'] ?? '';
      const gitconfig = existsSync(join(home, '.gitconfig')) ? readFileSync(join(home, '.gitconfig'), 'utf8') : '';
      for (const inc of gitconfig.matchAll(/\[includeIf "gitdir:([^"]+)"\]\n\tpath = (\S+)/g)) {
        if (m[1]!.startsWith(inc[1]!) && existsSync(inc[2]!)) return { stdout: `${/email = "([^"]+)"/.exec(readFileSync(inc[2]!, 'utf8'))?.[1] ?? ''}\n` };
      }
      return { stdout: '' };
    }
    if (line.startsWith('lsof ')) return { code: 1 };
    if (line.startsWith('ps ')) return { stdout: '' };
    if ((m = /^brew uninstall --(formula|cask) (\S+)$/.exec(line))) {
      state.uninstalled.push(m[2]!);
      return {};
    }
    // The work volume (spec A7.12).
    const vol = (id: string): FakeVolume | undefined => state.volumes?.find((v) => v.uuid === id.toUpperCase() || v.device === id || v.mountPoint === id);
    if ((m = /^diskutil info -plist (.+)$/.exec(line))) {
      const v = vol(m[1]!);
      if (!v) return { code: 1, stderr: `Could not find disk: ${m[1]}\n` };
      return { stdout: plistXml({ VolumeUUID: v.uuid, DeviceIdentifier: v.device, VolumeName: v.name, MountPoint: v.mountPoint ?? '', FilesystemType: v.apfs === false ? 'exfat' : 'apfs', Encryption: v.encrypted === true, Locked: v.locked === true, GlobalPermissionsEnabled: v.ownership === true, Internal: v.internal === true, TotalSize: v.totalBytes ?? 1e12, APFSContainerFree: v.freeBytes ?? 6e11, MediaName: 'Fake SSD' }) };
    }
    if (line === 'diskutil list -plist external physical') {
      return { stdout: plistXml({ WholeDisks: ['disk4'], AllDisksAndPartitions: [{ DeviceIdentifier: 'disk4', Size: 1e12, Content: 'GUID_partition_scheme', Partitions: [{ DeviceIdentifier: 'disk4s2' }] }] }) };
    }
    if (line === 'diskutil list -plist') {
      const ext = (state.volumes ?? []).filter((v) => !v.internal);
      return { stdout: plistXml({ AllDisksAndPartitions: [{ DeviceIdentifier: 'disk4', Size: 1e12, Content: 'GUID_partition_scheme', Partitions: [{ DeviceIdentifier: 'disk4s2' }] }, { DeviceIdentifier: 'disk5', APFSPhysicalStores: [{ DeviceIdentifier: 'disk4s2' }], APFSVolumes: ext.map((v) => ({ DeviceIdentifier: v.device, VolumeName: v.name, VolumeUUID: v.uuid, MountPoint: v.mountPoint ?? '', Size: v.totalBytes ?? 1e12 })) }] }) };
    }
    if ((m = /^diskutil enableOwnership (\S+)$/.exec(line))) {
      const v = vol(m[1]!);
      if (v) v.ownership = true;
      return v ? {} : { code: 1 };
    }
    if ((m = /^mdutil -s (.+)$/.exec(line))) return { stdout: `${m[1]}:\n\tIndexing ${state.spotlightOff?.has(m[1]!) ? 'disabled' : 'enabled'}.\n` };
    if ((m = /^mdutil -i off (.+)$/.exec(line))) {
      (state.spotlightOff ??= new Set()).add(m[1]!);
      return {};
    }
    if (line === 'defaults read /Library/Preferences/SystemConfiguration/autodiskmount AutomountDisksWithoutUserLogin') return state.automount ? { stdout: '1\n' } : { code: 1, stderr: 'does not exist' };
    if (line === 'defaults write /Library/Preferences/SystemConfiguration/autodiskmount AutomountDisksWithoutUserLogin -bool true') {
      state.automount = true;
      return {};
    }
    if (line === 'security find-generic-password -s devhost.workvolume -a devhost /Library/Keychains/System.keychain') return state.volumePassphrase !== undefined ? { stdout: 'keychain: "/Library/Keychains/System.keychain"\n' } : { code: 44 };
    if (line === 'security -i') {
      const input = String((call.opts as { input?: string } | undefined)?.input ?? '');
      const pm = /-w "((?:[^"\\]|\\.)*)" \/Library\/Keychains\/System\.keychain/.exec(input);
      if (!pm) return { code: 1 };
      state.volumePassphrase = pm[1]!.replace(/\\(.)/g, '$1');
      return {};
    }
    if (line === 'security delete-generic-password -s devhost.workvolume -a devhost /Library/Keychains/System.keychain') {
      delete state.volumePassphrase;
      return {};
    }
    if ((m = /^rsync -aH (\S+)\/ (\S+)\/$/.exec(line))) {
      cpSync(m[1]!, m[2]!, { recursive: true });
      return {};
    }
    if ((m = /^ls -A (\S+)$/.exec(line))) {
      try {
        return { stdout: readdirSync(m[1]!).join('\n') };
      } catch {
        return { code: 1 };
      }
    }
    if ((m = /^docker run --rm --pull=never -v (\S+):\/x:ro alpine ls -A \/x$/.exec(line))) {
      return { stdout: state.colimaSeesVolume === false ? '' : readdirSync(m[1]!).join('\n') };
    }
    if ((m = /^security find-generic-password -s (.+) -w$/.exec(line))) {
      const secret = state.keychain?.get(m[1]!);
      return secret === undefined ? { code: 44, stderr: 'The specified item could not be found in the keychain.' } : { stdout: `${secret}\n` };
    }
    if (line === 'brew list --formula -1') return { stdout: 'git\ncolima\njq\ntailscale\n' };
    if (line === 'brew list --cask -1') return { stdout: 'claude-code\n' };
    return { code: 127, stderr: `unexpected command in test: ${line}` };
  };
  runner.on(/.*/, dispatch);
  // `claude auth login`: prints a URL, wants the code on stdin, then the account is logged in.
  runner.onSpawn(/^\/opt\/homebrew\/bin\/claude auth login$/, (p, call) => {
    p.emit('Opening browser to sign in…\nIf it does not open, visit:\nhttps://claude.ai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ');
    p.onWrite((data) => {
      const dir = call.opts?.env?.['CLAUDE_CONFIG_DIR'] ?? 'default';
      state.loggedIn.add(dir);
      if (state.loginAs) (state.identities ??= new Map()).set(dir, state.loginAs);
      p.emit('Login successful\n');
      p.exit(0);
      void data;
    });
  });
  // `claude remote-control` under a pty (pty-run.py): asks for trust, then for the one-time Remote
  // Control confirmation. Like the real one it records the trust in .claude.json once it is answered yes.
  runner.onSpawn(/^\/usr\/bin\/python3 \S+pty-run\.py \/opt\/homebrew\/bin\/claude remote-control/, (p, call) => {
    const answers: string[] = [];
    if (state.claudeVersion.startsWith('2.1.8')) {
      p.emit(`Your version of Claude Code (${state.claudeVersion}) is too old for Remote Control.\nVersion 2.1.139 or higher is required.\n`);
      return p.exit(1);
    }
    p.emit(`Trust ${call.opts?.cwd}? [y/N] `);
    p.onWrite((data) => {
      if (data === '\u0003') return p.exit(0);
      answers.push(data);
      if (answers.length === 1 && data === 'y\n' && !state.claudeForgetsTrust) {
        const file = call.opts?.env?.['CLAUDE_CONFIG_DIR'] ? join(call.opts.env['CLAUDE_CONFIG_DIR'], '.claude.json') : join(runner.context['home'] ?? '', '.claude.json');
        const known = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, object> }) : {};
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ ...known, projects: { ...known.projects, [call.opts?.cwd ?? '']: { hasTrustDialogAccepted: true } } }));
      }
      if (answers.length === 1) p.emit('\nEnable Remote Control? (y/n) ');
      else p.emit('\nRemote Control server running.\n');
    });
  });
  return { runner, state };
}
