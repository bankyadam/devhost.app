import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    stdin: process.stdin,
    stdinIsTTY: tty,
    stdoutIsTTY: false,
    env: {},
    home,
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

const strip = (line: string): string => line.replace(/^sudo -n -- /, '');

/**
 * A stateful stand-in for a Mac: answers read-only commands from its state and
 * updates the state on the matching mutating commands. Lets tests prove that a
 * second `apply` changes nothing.
 */
export function fakeMac(initial: Partial<FakeState> = {}): { runner: MockRunner; state: FakeState } {
  const state: FakeState = {
    names: { ComputerName: 'old', HostName: 'old', LocalHostName: 'old' },
    power: { sleep: 1, disksleep: 10, autorestart: 0, womp: 0 },
    sshOn: false,
    brewInstalled: true,
    bundled: new Set(),
    mise: new Map(),
    ...initial,
  };
  const runner = new MockRunner();
  const dispatch = (call: { command: string; args: string[] }) => {
    const line = strip([call.command, ...call.args].join(' '));
    let m: RegExpExecArray | null;
    if ((m = /^scutil --get (\w+)$/.exec(line))) {
      return { stdout: `${state.names[m[1] as keyof FakeState['names']]}\n` };
    }
    if ((m = /^scutil --set (\w+) (\S+)$/.exec(line))) {
      state.names[m[1] as keyof FakeState['names']] = m[2]!;
      return {};
    }
    if (line === 'pmset -g custom') {
      return {
        stdout: `Battery Power:\nAC Power:\n sleep                ${state.power['sleep']} (sleep prevented by powerd)\n disksleep            ${state.power['disksleep']}\n womp                 ${state.power['womp']}\n autorestart          ${state.power['autorestart']}\n`,
      };
    }
    if (line.startsWith('pmset -a ')) {
      const parts = line.split(' ').slice(2);
      for (let i = 0; i < parts.length; i += 2) state.power[parts[i]!] = Number(parts[i + 1]);
      return {};
    }
    if (line.startsWith('nc -z')) return { code: state.sshOn ? 0 : 1 };
    if (line === 'systemsetup -setremotelogin on') {
      state.sshOn = true;
      return {};
    }
    if (line.startsWith('brew bundle check')) return { code: state.bundled.has('all') ? 0 : 1 };
    if (line.startsWith('brew bundle')) {
      state.bundled.add('all');
      return {};
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
    return { code: 127, stderr: `unexpected command in test: ${line}` };
  };
  runner.on(/.*/, dispatch);
  return { runner, state };
}

export interface FakeState {
  names: { ComputerName: string; HostName: string; LocalHostName: string };
  power: Record<string, number>;
  sshOn: boolean;
  brewInstalled: boolean;
  bundled: Set<string>;
  mise: Map<string, string>;
}
