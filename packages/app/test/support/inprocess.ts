import { PassThrough } from 'node:stream';
import type { Deps } from '../../../cli/src/deps.js';
import { main } from '../../../cli/src/main.js';
import type { RunResult, StreamHandle, TerminalRequest, Transport, TrayStatus } from '../../src/transport/types';

/**
 * The real devhost CLI behind the app's Transport interface: every command the app sends is executed
 * by `main()` against a fake Mac (see cli/test/helpers.ts). This keeps the app honest about the
 * contract without ssh or a Mac, and is the same code path a real host would run.
 */
export class InProcessTransport implements Transport {
  readonly calls: string[][] = [];
  readonly opened: { url?: string; terminal?: TerminalRequest; vscode?: string; webApp?: string }[] = [];
  /** Names of the Safari web apps in ~/Applications; `setupWebApp` records the icon it was given. */
  readonly webAppsInstalled = new Set<string>();
  readonly webAppIcons = new Map<string, Uint8Array>();
  readonly tray: { status: TrayStatus; waiting: number }[] = [];
  /** Simulates the host being offline (ssh exits 255). */
  offline = false;
  /** Rewrites a command's stdout (e.g. to fake another contract version). */
  rewrite: ((args: string[], stdout: string) => string) | null = null;
  tools = { code: true, iterm: false };
  private navigate: ((s: string) => void)[] = [];

  constructor(private readonly base: Deps, readonly host = 'macmini') {}

  private depsFor(stdin: PassThrough): { deps: Deps; out: string[] } {
    const out: string[] = [];
    const deps: Deps = { ...this.base, stdout: { write: (s) => void out.push(s) }, stderr: { write: () => undefined }, stdin, cancel: { cancelled: false } };
    return { deps, out };
  }

  async run(args: string[], opts?: { stdin?: string }): Promise<RunResult> {
    this.calls.push(args);
    if (this.offline) return { code: 255, stdout: '', stderr: 'ssh: connect to host macmini port 22: Operation timed out' };
    const stdin = new PassThrough();
    stdin.end(opts?.stdin ?? '');
    const { deps, out } = this.depsFor(stdin);
    const code = await main(args, deps);
    const stdout = out.join('');
    return { code, stdout: this.rewrite ? this.rewrite(args, stdout) : stdout, stderr: '' };
  }

  stream(args: string[], onLine: (line: string) => void): StreamHandle {
    this.calls.push(args);
    if (this.offline) return { write: () => undefined, cancel: () => undefined, done: Promise.resolve(255) };
    const stdin = new PassThrough();
    const { deps } = this.depsFor(stdin);
    let buffer = '';
    deps.stdout = {
      write: (s) => {
        buffer += s;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          onLine(this.rewrite ? this.rewrite(args, line) : line);
        }
      },
    };
    const done = main(args, deps);
    return {
      write: (line) => void stdin.write(`${line}\n`),
      cancel: () => {
        deps.cancel.cancelled = true;
        stdin.end();
      },
      done,
    };
  }

  async openUrl(url: string): Promise<void> {
    this.opened.push({ url });
  }
  async openTerminal(request: TerminalRequest): Promise<void> {
    this.opened.push({ terminal: request });
  }
  async openVscode(path: string): Promise<void> {
    this.opened.push({ vscode: path });
  }
  async detectTools(): Promise<{ code: boolean; iterm: boolean }> {
    return this.tools;
  }
  async listWebApps(): Promise<string[]> {
    return [...this.webAppsInstalled].sort();
  }
  async setupWebApp(account: string, png: Uint8Array): Promise<string> {
    this.webAppIcons.set(account, png);
    return `/Users/me/Library/Application Support/app.devhost.desktop/web-app-icons/Claude – ${account}.png`;
  }
  async openWebApp(name: string, url?: string): Promise<void> {
    this.opened.push({ webApp: name, ...(url ? { url } : {}) });
  }
  async setTray(status: TrayStatus, waiting: number): Promise<void> {
    this.tray.push({ status, waiting });
  }
  onNavigate(cb: (screen: string) => void): () => void {
    this.navigate.push(cb);
    return () => void (this.navigate = this.navigate.filter((c) => c !== cb));
  }
  emitNavigate(screen: string): void {
    this.navigate.forEach((c) => c(screen));
  }
}
