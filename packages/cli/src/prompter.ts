import { createInterface, type Interface } from 'node:readline';
import { validate } from '@devhost/contract';
import type { Deps, Sink } from './deps.js';
import { HumanActionRequired } from './errors.js';

/** Reads lines from stdin one at a time, buffering anything that arrives early. */
export class LineReader {
  /** Answers that arrived before their prompt was asked (e.g. a script writing all answers up front). */
  readonly inbox = new Map<string, string | boolean>();
  private readonly rl: Interface;
  private readonly it: AsyncIterator<string>;
  constructor(input: NodeJS.ReadableStream) {
    this.rl = createInterface({ input });
    this.it = this.rl[Symbol.asyncIterator]();
  }
  async next(): Promise<string | null> {
    const r = await this.it.next();
    return r.done ? null : r.value;
  }
  close(): void {
    this.rl.close();
  }
}

const readers = new WeakMap<Deps, LineReader>();
export function lineReaderFor(deps: Deps): LineReader {
  let r = readers.get(deps);
  if (!r) {
    r = new LineReader(deps.stdin);
    readers.set(deps, r);
  }
  return r;
}
export function closeInput(deps: Deps): void {
  readers.get(deps)?.close();
  readers.delete(deps);
}

/** Everything a command may need to ask a human (spec A7.10, A9 prompt events). */
export interface Prompter {
  confirm(id: string, message: string): Promise<boolean>;
  input(id: string, message: string): Promise<string>;
  /** Show a URL the human opens elsewhere; resolves with the code they paste back ('' if they just continue). */
  openUrl(id: string, url: string, message: string): Promise<string>;
}

/** Prompts as NDJSON events on stdout; answers are `{"id","value"}` lines on stdin (spec A9). */
export class JsonPrompter implements Prompter {
  constructor(
    private readonly out: Sink,
    private readonly reader: LineReader,
  ) {}

  private async ask(id: string, kind: 'open-url' | 'input' | 'confirm', message: string, url?: string): Promise<string | boolean> {
    this.out.write(`${JSON.stringify({ type: 'prompt', id, kind, message, ...(url ? { url } : {}) })}\n`);
    for (;;) {
      const early = this.reader.inbox.get(id);
      if (early !== undefined) {
        this.reader.inbox.delete(id);
        return early;
      }
      const line = await this.reader.next();
      if (line === null) {
        throw new HumanActionRequired(`no answer for prompt "${id}": stdin was closed`, 'Answer prompt events by writing {"id","value"} lines to stdin, or run the command in a terminal.');
      }
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const answer = validate<{ id: string; value: string | boolean }>('prompt-answer', parsed);
      if (!answer.ok) continue;
      if (answer.value.id === id) return answer.value.value;
      this.reader.inbox.set(answer.value.id, answer.value.value);
    }
  }
  async confirm(id: string, message: string): Promise<boolean> {
    const v = await this.ask(id, 'confirm', message);
    return v === true || v === 'true' || v === 'yes' || v === 'y';
  }
  async input(id: string, message: string): Promise<string> {
    return String(await this.ask(id, 'input', message));
  }
  async openUrl(id: string, url: string, message: string): Promise<string> {
    const v = await this.ask(id, 'open-url', message, url);
    return typeof v === 'string' ? v : '';
  }
}

/** Questions on the terminal (stderr, so stdout stays clean). */
export class HumanPrompter implements Prompter {
  constructor(
    private readonly out: Sink,
    private readonly reader: LineReader,
  ) {}
  private async line(prompt: string): Promise<string> {
    this.out.write(prompt);
    const l = await this.reader.next();
    if (l === null) this.out.write('\n');
    return (l ?? '').trim();
  }
  async confirm(_id: string, message: string): Promise<boolean> {
    return /^y(es)?$/i.test(await this.line(`${message} [y/N] `));
  }
  async input(_id: string, message: string): Promise<string> {
    return this.line(`${message} `);
  }
  async openUrl(_id: string, url: string, message: string): Promise<string> {
    this.out.write(`${message}\n  ${url}\n`);
    return this.line('Paste the code here (or press Enter if the browser finished by itself): ');
  }
}

/** No terminal and no --json: anything that needs a human is a "human action required" (exit 3). */
export class NoPrompter implements Prompter {
  private fail(message: string): never {
    throw new HumanActionRequired(message, 'Run this command in a terminal on this host (or over `ssh -t`).');
  }
  confirm(_id: string, message: string): Promise<boolean> {
    return this.fail(message);
  }
  input(_id: string, message: string): Promise<string> {
    return this.fail(message);
  }
  openUrl(_id: string, _url: string, message: string): Promise<string> {
    return this.fail(message);
  }
}

export function makePrompter(deps: Deps, json: boolean, yes: boolean): Prompter {
  const base: Prompter = json
    ? new JsonPrompter(deps.stdout, lineReaderFor(deps))
    : deps.stdinIsTTY
      ? new HumanPrompter(deps.stderr, lineReaderFor(deps))
      : new NoPrompter();
  if (!yes) return base;
  // --yes answers plain confirmations; typed input and URLs still need a human.
  return {
    confirm: async () => true,
    input: (id, m) => base.input(id, m),
    openUrl: (id, u, m) => base.openUrl(id, u, m),
  };
}
