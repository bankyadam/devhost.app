import type { Runner } from './runner/types.js';

export interface Sink {
  write(chunk: string): unknown;
}

/** Everything the CLI touches from the outside world, so tests can replace it. */
export interface Deps {
  stdout: Sink;
  stderr: Sink;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: Record<string, string | undefined>;
  home: string;
  /** The macOS account that runs services (LaunchDaemon UserName). */
  user: string;
  runner: Runner;
  now: () => Date;
  /** Set by the SIGINT handler; long-running commands stop after the current step. */
  cancel: { cancelled: boolean };
}
