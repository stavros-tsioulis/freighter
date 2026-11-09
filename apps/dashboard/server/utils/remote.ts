import type { H3Event } from "h3";

/**
 * `FREIGHTER_API_URL`: use another Freighter's API instead of the one built into this server, e.g. to try a local
 * dashboard against a real control plane (`FREIGHTER_API_URL=https://freighter.example.com pnpm dev`). Everything under
 * /api is then forwarded there, and this process opens no registry and runs no background loops of its own.
 * Returns the origin without a trailing slash, or null when unset.
 */
export function remoteApiUrl(): string | null {
  const raw = process.env.FREIGHTER_API_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`FREIGHTER_API_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`FREIGHTER_API_URL must be http(s), got ${url.protocol}`);
  return url.origin;
}

// Only what the API looks at: the session cookie or token, and the CSRF marker the UI adds.
const FORWARD = ["cookie", "authorization", "content-type", "content-length", "accept", "x-requested-with"];
// fetch() has already decoded the body, so the length and encoding of the original no longer apply.
const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

/**
 * The session cookie the remote sets is `Secure` (over HTTPS) and may name its domain; neither would be accepted for
 * http://localhost, so both are dropped. The cookie is then simply this server's own.
 */
export const localCookie = (c: string) => c.split(";").map((p) => p.trim()).filter((p) => !/^(secure|domain=)/i.test(p)).join("; ");

export async function proxyToRemote(event: H3Event, origin: string): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARD) {
    const v = event.node.req.headers[name];
    if (typeof v === "string") headers.set(name, v);
  }
  const hasBody = !["GET", "HEAD"].includes(event.method);
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${event.path}`, {
      method: event.method,
      headers,
      body: hasBody ? getRequestWebStream(event) : undefined,
      duplex: "half",
      redirect: "manual",
    } as RequestInit);
  } catch (e) {
    return new Response(JSON.stringify({ error: { code: "bad_gateway", message: `cannot reach ${origin}: ${e instanceof Error ? e.message : String(e)}` } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  const out = new Headers();
  upstream.headers.forEach((v, k) => { if (!DROP.has(k)) out.set(k, v); });
  for (const c of upstream.headers.getSetCookie()) out.append("set-cookie", localCookie(c));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
