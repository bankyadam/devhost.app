import type { RunOptions, RunResult, Runner, SpawnedProcess } from './types.js';

export interface RecordedCall {
  command: string;
  args: string[];
  opts: RunOptions | undefined;
}

type Responder = RunResult | ((call: RecordedCall) => RunResult);

/** Test double for a spawned process: the test pushes output and sees what was written. */
export class FakeProcess implements SpawnedProcess {
  readonly written: string[] = [];
  killed: NodeJS.Signals | null = null;
  private listeners: ((chunk: string) => void)[] = [];
  private resolveExit!: (code: number) => void;
  private readonly exited = new Promise<number>((r) => (this.resolveExit = r));
  private writeHooks: ((data: string) => void)[] = [];

  onData(cb: (chunk: string) => void): void {
    this.listeners.push(cb);
  }
  write(data: string): void {
    this.written.push(data);
    this.writeHooks.forEach((h) => h(data));
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed = signal;
    this.resolveExit(143);
  }
  wait(): Promise<number> {
    return this.exited;
  }

  /** Test API */
  emit(chunk: string): void {
    this.listeners.forEach((l) => l(chunk));
  }
  exit(code = 0): void {
    this.resolveExit(code);
  }
  onWrite(hook: (data: string) => void): void {
    this.writeHooks.push(hook);
  }
}

/** Scripted runner for tests: first matching rule wins, anything else exits 127. */
export class MockRunner implements Runner {
  readonly calls: RecordedCall[] = [];
  readonly spawned: { call: RecordedCall; process: FakeProcess }[] = [];
  private readonly rules: { match: (line: string) => boolean; respond: Responder }[] = [];
  private readonly spawnRules: { match: (line: string) => boolean; script: (p: FakeProcess, call: RecordedCall) => void }[] = [];

  /** `line` is `command arg1 arg2 ...`. A string matches as prefix, a RegExp as pattern. */
  on(line: string | RegExp, respond: Partial<RunResult> | ((call: RecordedCall) => Partial<RunResult>)): this {
    const full = (r: Partial<RunResult>): RunResult => ({ code: 0, stdout: '', stderr: '', ...r });
    this.rules.push({
      match: matcher(line),
      respond: typeof respond === 'function' ? (c) => full(respond(c)) : full(respond),
    });
    return this;
  }

  /** Script a streaming process: `script` runs right after spawn (output is delivered asynchronously). */
  onSpawn(line: string | RegExp, script: (p: FakeProcess, call: RecordedCall) => void): this {
    this.spawnRules.push({ match: matcher(line), script });
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

  spawn(command: string, args: string[], opts?: RunOptions): SpawnedProcess {
    const call = { command, args, opts };
    this.calls.push(call);
    const process = new FakeProcess();
    this.spawned.push({ call, process });
    const line = [command, ...args].join(' ');
    const rule = this.spawnRules.find((r) => r.match(line));
    if (rule) setTimeout(() => rule.script(process, call), 0);
    else setTimeout(() => process.exit(127), 0);
    return process;
  }

  lines(): string[] {
    return this.calls.map((c) => [c.command, ...c.args].join(' '));
  }
}

function matcher(line: string | RegExp): (l: string) => boolean {
  return typeof line === 'string' ? (l) => l.startsWith(line) : (l) => line.test(l);
}
