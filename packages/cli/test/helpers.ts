import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  composeUp: Set<string>;
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
  /** `claude --version`; `brew upgrade --cask claude-code` moves it to 2.1.300. */
  claudeVersion: string;
  /** The fake claude acknowledges the trust question but does not record it (it stopped, or lost the write). */
  claudeForgetsTrust: boolean;
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
  const dispatch = (call: { command: string; args: string[]; opts?: { env?: Record<string, string>; cwd?: string } }) => {
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
    if (line === 'tailscale status --json') {
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
    if (line.startsWith('launchctl kickstart')) return {};
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
      return {};
    }
    if ((m = /^git -C (\S+) rev-parse --git-dir$/.exec(line))) return { code: existsSync(join(m[1]!, '.git')) ? 0 : 128 };
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
    if ((m = /^docker compose -p (\S+) ps -q/.exec(line))) return { stdout: state.composeUp.has(m[1]!) ? 'abc123\n' : '' };
    if (line === 'sw_vers -productVersion') return { stdout: '26.0\n' };
    if (line === 'uname -m') return { stdout: `${state.arch}\n` };
    if (line === 'sysctl -n sysctl.proc_translated') return state.rosetta ? { stdout: '1\n' } : { code: 1, stderr: 'unknown oid\n' };
    if (line === 'fdesetup status') return { stdout: `FileVault is ${state.fileVault}.\n` };
    if (line === 'brew --version') return { stdout: 'Homebrew 5.0.0\n' };
    if (line.startsWith('df -k /')) return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 1000000 500000 500000 50% /\n' };
    if (line.startsWith('docker info')) return state.colimaRunning ? { stdout: '27.0\n' } : { code: 1 };
    if (line === `${brewBin()}/claude --version`) return { stdout: `${state.claudeVersion} (Claude Code)\n` };
    if (line === 'brew upgrade --cask claude-code') {
      state.claudeVersion = '2.1.300';
      return {};
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
