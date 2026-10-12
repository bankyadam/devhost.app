import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { InitData } from '@devhost/contract';
import { parseConfig } from '../config/load.js';
import type { Deps } from '../deps.js';
import { UsageError } from '../errors.js';
import { exists, writeTextWithBackup } from '../fsutil.js';
import { renderTemplate } from '../render.js';

export interface InitOptions {
  force: boolean;
  /** Never ask questions: use flags and defaults. */
  nonInteractive: boolean;
  hostname?: string;
  docker?: string;
  tailscale: boolean;
}

const DOCKER_RUNTIMES = ['colima', 'orbstack', 'none'];

export function generateTopic(): string {
  return `devhost-${randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

type Lines = AsyncIterator<string>;

/** Reads answers through the line iterator, which (unlike rl.question) keeps lines that arrive early. */
async function ask(lines: Lines, out: NodeJS.WritableStream, question: string, fallback: string): Promise<string> {
  out.write(`${question} [${fallback}] `);
  const next = await lines.next();
  const answer = next.done ? '' : next.value.trim();
  if (next.done) out.write('\n');
  return answer === '' ? fallback : answer;
}

export async function runInit(configPath: string, opts: InitOptions, deps: Deps): Promise<InitData> {
  const already = await exists(configPath);
  if (already && !opts.force) {
    throw new UsageError(`${configPath} already exists`, 'Use --force to overwrite it (a backup is kept), or `devhost config set` to change values.');
  }

  let hostname = opts.hostname ?? 'macmini';
  let docker = opts.docker ?? 'colima';
  let tailscale = opts.tailscale;

  if (!opts.nonInteractive) {
    const out = deps.stderr as NodeJS.WritableStream;
    const rl = createInterface({ input: deps.stdin });
    const lines = rl[Symbol.asyncIterator]();
    try {
      if (opts.hostname === undefined) hostname = await ask(lines, out, 'Hostname of this Mac', hostname);
      if (opts.docker === undefined) docker = await ask(lines, out, `Docker runtime (${DOCKER_RUNTIMES.join('/')})`, docker);
      if (tailscale) {
        const t = (await ask(lines, out, 'Set up Tailscale for remote access? (y/n)', 'y')).toLowerCase();
        tailscale = t.startsWith('y');
      }
    } finally {
      rl.close();
    }
  }

  if (!DOCKER_RUNTIMES.includes(docker)) {
    throw new UsageError(`unknown docker runtime "${docker}"`, `Choose one of: ${DOCKER_RUNTIMES.join(', ')}`);
  }

  const content = await renderTemplate('config.yaml', {
    hostname,
    dockerRuntime: docker,
    tailscale: String(tailscale),
    topic: generateTopic(),
  });
  // Never write a config that our own validator rejects (e.g. a bad hostname).
  parseConfig(content, configPath);

  const { backup } = await writeTextWithBackup(configPath, content, {
    now: deps.now(),
    mode: 0o600,
    dirMode: 0o700,
  });
  return { path: configPath, created: !already, hostname, overwritten: already, backup };
}
