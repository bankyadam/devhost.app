import type { Event } from '@devhost/contract';
import type { Sink } from './deps.js';

export type StepStatus = 'start' | 'ok' | 'changed' | 'skipped' | 'failed';
export type LogLevel = 'info' | 'warn' | 'error';

/** Progress channel for long-running commands (spec A9 events). */
export interface Reporter {
  step(id: string, status: StepStatus, message?: string): void;
  log(level: LogLevel, message: string): void;
}

export class NdjsonReporter implements Reporter {
  constructor(private readonly out: Sink) {}

  emit(event: Event): void {
    this.out.write(`${JSON.stringify(event)}\n`);
  }
  step(id: string, status: StepStatus, message?: string): void {
    this.emit({ type: 'step', id, status, ...(message ? { message } : {}) });
  }
  log(level: LogLevel, message: string): void {
    this.emit({ type: 'log', level, message });
  }
}

const SYMBOL: Record<Exclude<StepStatus, 'start'>, string> = {
  ok: '✅',
  changed: '🔧',
  skipped: '⏭️ ',
  failed: '❌',
};

/**
 * Plain text; stays free of ANSI codes so output is also safe to pipe. A step's result line only
 * comes when it ends, so one still running after `slowAfterMs` gets a "… id — description" line:
 * otherwise a long `brew bundle` looks like a hang.
 */
export class HumanReporter implements Reporter {
  private slow: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly out: Sink,
    private readonly err: Sink,
    private readonly verbose: boolean,
    private readonly slowAfterMs = 3000,
  ) {}

  step(id: string, status: StepStatus, message?: string): void {
    clearTimeout(this.slow);
    this.slow = undefined;
    if (status === 'start') {
      const line = `… ${id}${message ? ` — ${message}` : ''}\n`;
      if (this.verbose) this.out.write(line);
      else {
        this.slow = setTimeout(() => this.out.write(line), this.slowAfterMs);
        this.slow.unref?.();
      }
      return;
    }
    this.out.write(`${SYMBOL[status]} ${id}${message ? ` — ${message}` : ''}\n`);
  }
  log(level: LogLevel, message: string): void {
    if (level === 'info') {
      this.err.write(`${message}\n`);
    } else {
      this.err.write(`${level === 'warn' ? '⚠️  ' : '❌ '}${message}\n`);
    }
  }
}
