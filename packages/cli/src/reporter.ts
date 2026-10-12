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

/** Plain text; stays free of ANSI codes so output is also safe to pipe. */
export class HumanReporter implements Reporter {
  constructor(
    private readonly out: Sink,
    private readonly err: Sink,
    private readonly verbose: boolean,
  ) {}

  step(id: string, status: StepStatus, message?: string): void {
    if (status === 'start') {
      if (this.verbose) this.out.write(`… ${id}\n`);
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
