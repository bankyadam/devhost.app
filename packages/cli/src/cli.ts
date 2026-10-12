#!/usr/bin/env node
import { homedir } from 'node:os';
import { main } from './main.js';
import type { Deps } from './deps.js';
import { RealRunner } from './runner/real.js';

const HOMEBREW_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin';

const env = { ...process.env };
// launchd and ssh give a minimal PATH; make Homebrew tools findable (spec A5).
env['PATH'] = [HOMEBREW_PATH, env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');

const deps: Deps = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  env,
  home: homedir(),
  runner: new RealRunner(env),
  now: () => new Date(),
  cancel: { cancelled: false },
};

// SIGINT: finish the current step, leave a consistent state (spec A9).
process.on('SIGINT', () => {
  if (deps.cancel.cancelled) process.exit(130);
  deps.cancel.cancelled = true;
});

main(process.argv.slice(2), deps).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
