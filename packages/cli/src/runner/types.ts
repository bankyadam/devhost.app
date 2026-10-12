export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  /** Data written to the child's stdin. */
  input?: string;
  timeoutMs?: number;
  /** Child inherits the terminal (editor, sudo password prompt). Output is not captured. */
  interactive?: boolean;
  /** Variables removed from the child's environment (e.g. CLAUDE_CONFIG_DIR for the default account). */
  unsetEnv?: string[];
}

export interface RunResult {
  /** Exit code. 127 when the command does not exist; 124 on timeout. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The only thing in devhost that spawns processes. Never throws on a
 * non-zero exit or a missing binary; both come back as a RunResult.
 * Tests replace this with a scripted fake.
 */
export interface Runner {
  run(command: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** Start a long-lived child whose output is streamed and whose stdin can be written (login, trust prompts). */
  spawn(command: string, args: string[], opts?: RunOptions): SpawnedProcess;
}

export interface SpawnedProcess {
  /** stdout and stderr, merged, as they arrive. */
  onData(cb: (chunk: string) => void): void;
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with the exit code (127 when the command does not exist). */
  wait(): Promise<number>;
}
