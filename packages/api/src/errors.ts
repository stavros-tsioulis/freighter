import { AgentError } from "@freighter/protocol";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const agentStatus = { bad_request: 400, not_found: 404, conflict: 409, deploy_failed: 422, build_failed: 422, unavailable: 503, timeout: 504, internal: 502 } as const;

/** Normalize anything thrown by a handler into an HTTP status and error body. */
export function toHttpError(e: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (e instanceof ApiError) return { status: e.status, body: { error: { code: e.code, message: e.message } } };
  if (e instanceof AgentError) {
    const code = e.code === "unavailable" ? "agent_unavailable" : e.code;
    return { status: agentStatus[e.code], body: { error: { code, message: e.message } } };
  }
  if (e instanceof ZodError) {
    return { status: 400, body: { error: { code: "bad_request", message: e.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ") } } };
  }
  console.error("unhandled API error", e);
  return { status: 500, body: { error: { code: "internal", message: "internal error" } } };
}
