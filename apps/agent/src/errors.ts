import type { WireError } from "@freighter/protocol";

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export function formatIssues(issues: readonly ValidationIssue[], emptyPathLabel = ""): string {
  return issues.map((issue) => `${issue.path.join(".") || emptyPathLabel}: ${issue.message}`).join("; ");
}

export function badRequest(message: string): WireError {
  return { code: "bad_request", message };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
