export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StreamHandle {
  /** One line to the remote command's stdin (prompt answers). */
  write(line: string): void;
  /** Stop the remote command. devhost steps are safe to re-run afterwards. */
  cancel(): void;
  /** Resolves with the exit code once the command has ended. */
  done: Promise<number>;
}

export type TerminalRequest =
  | { kind: 'devhost'; args: string[] }
  | { kind: 'shell'; dir: string }
  | { kind: 'resume'; dir: string; sessionId: string };

export type TrayStatus = 'green' | 'yellow' | 'red';

/**
 * Everything the app needs from the machine it runs on. The real implementation talks to the
 * Rust shell (system ssh); tests plug the CLI itself in behind this interface.
 */
export interface Transport {
  readonly host: string;
  /** `devhost <args>` on the host; output captured. ssh's own failure is exit code 255. */
  run(args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<RunResult>;
  /** `devhost <args>` on the host; every stdout line goes to `onLine`. */
  stream(args: string[], onLine: (line: string) => void): StreamHandle;
  openUrl(url: string): Promise<void>;
  openTerminal(request: TerminalRequest): Promise<void>;
  openVscode(path: string): Promise<void>;
  detectTools(): Promise<{ code: boolean; iterm: boolean }>;
  /** Which accounts have their Safari web app (`~/Applications/Claude – <account>.app`). */
  webApps(accounts: string[]): Promise<Record<string, boolean>>;
  /** Save the account's icon (PNG), open claude.ai/code in Safari, show the icon in Finder. Resolves with the icon's path. */
  setupWebApp(account: string, png: Uint8Array): Promise<string>;
  openWebApp(account: string): Promise<void>;
  setTray(status: TrayStatus, waiting: number): Promise<void>;
  /** Subscribe to menu-bar navigation requests ("dashboard" | "environments"). */
  onNavigate(cb: (screen: string) => void): () => void;
}
