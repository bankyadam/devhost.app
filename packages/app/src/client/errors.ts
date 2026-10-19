import type { Envelope } from '@devhost/contract/lite';

export type ErrorEntry = Envelope['errors'][number];

/** The command ran and reported a problem (exit 1, 2 or 3). */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exit: number,
    readonly errors: ErrorEntry[] = [],
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
  /** Exit code 3: a human has to do something (typically type a sudo password in a terminal). */
  get needsHuman(): boolean {
    return this.exit === 3;
  }
}

/** ssh could not reach the host (or it did not answer in time). */
export class UnreachableError extends Error {
  constructor(message: string, readonly stderr = '') {
    super(message);
    this.name = 'UnreachableError';
  }
}

/** The CLI on the host speaks another contract major than this app (spec B2). */
export class IncompatibleError extends Error {
  constructor(readonly cliVersion: string, readonly cliContract: number, readonly appContract: number) {
    super(
      `The devhost CLI on the host (${cliVersion}) speaks contract ${cliContract}, this app speaks ${appContract}. ` +
        (cliContract > appContract ? 'Update devhost Desktop.' : 'Update devhost on the host (git pull && ./bootstrap.sh).'),
    );
    this.name = 'IncompatibleError';
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
