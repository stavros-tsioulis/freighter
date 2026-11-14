import { REQUEST_TIMEOUT_MS } from "./constants.ts";
import { resolveConnection } from "./config.ts";

type Query = Record<string, string | number | boolean | undefined>;

/** An API failure: the HTTP status, Freighter's own error code, and a message that says how to go on. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function recovery(status: number, message: string): string {
  switch (status) {
    case 401:
      return "Freighter rejected the API token. Check FREIGHTER_TOKEN, or sign in again with `freighter login`.";
    case 403:
      return `${message}. This token's role is too low for that: viewer can look, deployer can deploy and restart, admin can also change secrets, run commands and manage servers.`;
    case 404:
      return `${message}. Use freighter_list_apps (or the matching list tool) to see what exists.`;
    case 409:
      return `${message}. It may be waiting on another deployment: check freighter_list_deployments.`;
    default:
      return message;
  }
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

/** One request to the Freighter API with the configured token. Throws ApiError, with text the model can act on. */
export async function api<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
  const c = resolveConnection();
  const url = new URL(`${c.url}/api/v1${path}`);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${c.token}`, accept: "application/json", ...(o.body === undefined ? {} : { "content-type": "application/json" }) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error(`Freighter at ${c.url} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`);
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error(`Cannot reach Freighter at ${c.url} (from ${c.source}): ${(e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.message : String(e))}.`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
      message = j.error?.message ?? message;
      code = j.error?.code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, recovery(res.status, message), code);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const apiGet = <T>(path: string, query?: Query, signal?: AbortSignal) => api<T>("GET", path, { query, signal });
export const apiPost = <T>(path: string, body: unknown = {}, o: { query?: Query; signal?: AbortSignal } = {}) => api<T>("POST", path, { body, ...o });
export const apiPut = <T>(path: string, body: unknown = {}, signal?: AbortSignal) => api<T>("PUT", path, { body, signal });
export const apiDelete = <T>(path: string, body?: unknown, signal?: AbortSignal) => api<T>("DELETE", path, { body, signal });
