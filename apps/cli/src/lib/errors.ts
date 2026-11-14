/** The exit codes of `freighter` (see docs/cli). */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  deployFailed: 5,
  interrupted: 130,
} as const;

/** Something to tell the person in one line, and the exit code to end with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.failed,
    /** A next step worth printing under the message. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usage = (message: string, hint?: string) => new CliError(message, EXIT.usage, hint);
