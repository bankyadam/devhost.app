import type { RunOptions, RunResult, Runner } from './types.js';

export interface RecordedCall {
  command: string;
  args: string[];
  opts: RunOptions | undefined;
}

type Responder = RunResult | ((call: RecordedCall) => RunResult);

/** Scripted runner for tests: first matching rule wins, anything else exits 127. */
export class MockRunner implements Runner {
  readonly calls: RecordedCall[] = [];
  private readonly rules: { match: (line: string) => boolean; respond: Responder }[] = [];

  /** `line` is `command arg1 arg2 ...`. A string matches as prefix, a RegExp as pattern. */
  on(line: string | RegExp, respond: Partial<RunResult> | ((call: RecordedCall) => Partial<RunResult>)): this {
    const match = typeof line === 'string' ? (l: string) => l.startsWith(line) : (l: string) => line.test(l);
    const full = (r: Partial<RunResult>): RunResult => ({ code: 0, stdout: '', stderr: '', ...r });
    this.rules.push({
      match,
      respond: typeof respond === 'function' ? (c) => full(respond(c)) : full(respond),
    });
    return this;
  }

  run(command: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    const call = { command, args, opts };
    this.calls.push(call);
    const line = [command, ...args].join(' ');
    for (const rule of this.rules) {
      if (rule.match(line)) {
        return Promise.resolve(typeof rule.respond === 'function' ? rule.respond(call) : rule.respond);
      }
    }
    return Promise.resolve({ code: 127, stdout: '', stderr: `command not found: ${command}\n` });
  }

  lines(): string[] {
    return this.calls.map((c) => [c.command, ...c.args].join(' '));
  }
}
