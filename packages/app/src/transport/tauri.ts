import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RunResult, StreamHandle, TerminalRequest, Transport, TrayStatus } from './types';

interface LineEvent { id: string; line: string }
interface ExitEvent { id: string; code: number }

/** Talks to the Rust shell, which runs the system `ssh` (keys, agent and ~/.ssh/config as the user set them up). */
export function createTauriTransport(host: string): Transport {
  const lineHandlers = new Map<string, (line: string) => void>();
  const exitHandlers = new Map<string, (code: number) => void>();
  let ready: Promise<void> | null = null;

  // One global listener per event, dispatching by stream id: no listen/unlisten races per call.
  const ensureListeners = (): Promise<void> => {
    ready ??= Promise.all([
      listen<LineEvent>('ssh-line', (e) => lineHandlers.get(e.payload.id)?.(e.payload.line)),
      listen<ExitEvent>('ssh-exit', (e) => exitHandlers.get(e.payload.id)?.(e.payload.code)),
    ]).then(() => undefined);
    return ready;
  };

  return {
    host,
    run: (args, opts) =>
      invoke<RunResult>('ssh_run', { host, args, stdin: opts?.stdin ?? null, timeoutMs: opts?.timeoutMs ?? null }),

    stream(args, onLine): StreamHandle {
      const id = crypto.randomUUID();
      let finished = false;
      let resolve!: (code: number) => void;
      const done = new Promise<number>((r) => (resolve = r));
      const finish = (code: number): void => {
        if (finished) return;
        finished = true;
        lineHandlers.delete(id);
        exitHandlers.delete(id);
        resolve(code);
      };
      lineHandlers.set(id, onLine);
      exitHandlers.set(id, finish);
      void ensureListeners()
        .then(() => invoke('ssh_stream_start', { id, host, args }))
        .catch(() => finish(255));
      return {
        write: (line) => void invoke('ssh_stream_write', { id, line }).catch(() => undefined),
        cancel: () => void invoke('ssh_stream_kill', { id }).catch(() => undefined),
        done,
      };
    },

    openUrl: (url) => invoke('open_url', { url }),
    openTerminal: (request: TerminalRequest) =>
      invoke('open_terminal', {
        host,
        action: request.kind === 'resume' ? { kind: 'resume', dir: request.dir, sessionId: request.sessionId } : request,
      }),
    openVscode: (path) => invoke('open_vscode', { host, path }),
    detectTools: () => invoke('detect_tools'),
    listWebApps: () => invoke('list_web_apps'),
    setupWebApp: (account, png) => invoke('setup_web_app', { account, png: Array.from(png) }),
    openWebApp: (name, url) => invoke('open_web_app', { name, url: url ?? null }),
    setTray: (status: TrayStatus, waiting: number) => invoke('set_tray', { status, waiting }),
    onNavigate(cb) {
      let un: (() => void) | undefined;
      let cancelled = false;
      void listen<string>('navigate', (e) => cb(e.payload)).then((u) => (cancelled ? u() : (un = u)));
      return () => {
        cancelled = true;
        un?.();
      };
    },
  };
}

export const insideTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
