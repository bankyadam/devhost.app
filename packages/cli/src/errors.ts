import { ExitCode, type ValidationIssue } from '@devhost/contract';

export class DevhostError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: ExitCode = ExitCode.ChecksFailed,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad flags or arguments (exit 2). */
export class UsageError extends DevhostError {
  constructor(message: string, hint?: string) {
    super(message, 'usage', ExitCode.Usage, hint);
  }
}

/** Config file missing, unparsable or failing validation (exit 2). */
export class ConfigError extends DevhostError {
  constructor(
    message: string,
    readonly issues: ValidationIssue[] = [],
    hint?: string,
  ) {
    super(message, 'config-invalid', ExitCode.Usage, hint);
  }
}

/** Something only a human can do, e.g. a macOS permission dialog (exit 3). */
export class HumanActionRequired extends DevhostError {
  constructor(message: string, hint: string) {
    super(message, 'human-action-required', ExitCode.HumanActionRequired, hint);
  }
}

export class CommandError extends DevhostError {
  constructor(
    readonly command: string,
    readonly exit: number,
    readonly stderr: string,
  ) {
    super(
      `\`${command}\` failed with exit code ${exit}${stderr.trim() ? `: ${firstLine(stderr)}` : ''}`,
      'command-failed',
      ExitCode.ChecksFailed,
    );
  }
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
