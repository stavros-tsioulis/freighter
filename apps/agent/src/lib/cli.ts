import { describeError } from "../errors.ts";

export const CLI_VERSION = "0.0.0";

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
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

/** citty reports a misused command with one of its own errors: that is a usage error here. */
export const isUsageError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && error.name === "CLIError";

/** Print a failure in one line and end with its exit code. */
export function fail(error: unknown): never {
  const cliError = error instanceof CliError ? error : new CliError(describeError(error));
  process.stderr.write(`error: ${cliError.message}\n`);
  if (cliError.hint) process.stderr.write(`${cliError.hint}\n`);
  process.exit(cliError.code);
}

/** Options shared by the commands that read the host config. */
export const commonArgs = {
  prefix: {
    type: "string",
    description: "Dev mode: relocate all paths under this dir and skip systemctl/useradd",
  },
} as const;
