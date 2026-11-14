import { CliError, EXIT } from "./errors.ts";

type Query = Record<string, string | number | boolean | undefined>;
/** What `fetch` takes as a body. */
export type Body = NonNullable<NonNullable<ConstructorParameters<typeof Request>[1]>["body"]>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** A body that is not JSON (an upload), with its content type. */
  raw?: { body: Body; type: string; /** Bytes in a streamed body, for servers that want a Content-Length. */ length?: number };
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** A client for the control server's HTTP API, signed in with a bearer token. */
export class Api {
  constructor(
    readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private target(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return `${this.url}/api/v1${path}${s ? `?${s}` : ""}`;
  }

  /** The response itself, for streams and downloads. A failed one has already been turned into an error. */
  async response(method: string, path: string, o: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...o.headers };
    let body: Body | undefined;
    if (o.raw) {
      headers["content-type"] = o.raw.type;
      if (o.raw.length !== undefined) headers["content-length"] = String(o.raw.length);
      body = o.raw.body;
    } else if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.target(path, o.query), { method, headers, body, signal: o.signal, ...(o.raw?.body && typeof o.raw.body !== "string" ? { duplex: "half" } : {}) } as RequestInit);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new CliError(`cannot reach ${this.url}: ${(e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.message : String(e))}`, EXIT.failed, "check the URL, and your network");
    }
    if (!res.ok) throw await errorOf(res, this.url);
    return res;
  }

  async request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const res = await this.response(method, path, o);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body: body ?? {}, query });
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body: body ?? {} });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body: body ?? {} });
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, body === undefined ? {} : { body });
  }
}

/** An API failure as the message to show and the exit code it deserves. */
async function errorOf(res: Response, url: string): Promise<CliError> {
  const text = await res.text().catch(() => "");
  let message = res.statusText || `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string }; message?: string };
    message = j.error?.message ?? j.message ?? message;
    code = j.error?.code;
  } catch {
    if (text && text.length < 300 && !text.startsWith("<")) message = text;
  }
  if (res.status === 401) return new CliError("not signed in, or the token was revoked", EXIT.auth, `sign in again with \`freighter login ${url}\``);
  if (res.status === 403) return new CliError(message, EXIT.auth);
  if (res.status === 404) return new CliError(message, EXIT.notFound);
  const err = new CliError(message, EXIT.failed);
  (err as CliError & { apiCode?: string }).apiCode = code;
  return err;
}

export const apiCode = (e: unknown): string | undefined => (e as { apiCode?: string } | undefined)?.apiCode;
