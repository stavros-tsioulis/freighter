import { roleAtLeast, type Role } from "@freighter/registry";
import { getCookie, getHeader, getMethod, getRequestIP, type H3Event } from "h3";
import type { ApiContext, Principal } from "./context.ts";
import { ApiError } from "./errors.ts";

const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;

/** Counts failed authentications per client address; blocks further attempts for the rest of the window. */
export function createFailureLimiter(now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    assertAllowed(key: string) {
      const h = hits.get(key);
      if (h && h.resetAt > now() && h.count >= MAX_FAILURES) throw new ApiError(429, "rate_limited", "too many failed authentication attempts; try again later");
    },
    recordFailure(key: string) {
      const t = now();
      const h = hits.get(key);
      if (!h || h.resetAt <= t) hits.set(key, { count: 1, resetAt: t + WINDOW_MS });
      else h.count++;
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    },
  };
}
export type FailureLimiter = ReturnType<typeof createFailureLimiter>;

export const SESSION_COOKIE = "fr_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOKEN_RE = /^fr_[A-Za-z0-9_-]+$/;

export const clientIp = (event: H3Event, ctx: ApiContext) => getRequestIP(event, { xForwardedFor: ctx.trustProxy }) ?? "unknown";

/**
 * Cookie-authenticated (and login/logout) requests that change state must carry `X-Requested-With: freighter`.
 * Browsers cannot add that header cross-site without a CORS preflight, and no CORS is enabled.
 */
export function assertCsrfHeader(event: H3Event) {
  if (getHeader(event, "x-requested-with") !== "freighter") throw new ApiError(403, "csrf", "missing X-Requested-With: freighter header");
}

export function authenticate(event: H3Event, ctx: ApiContext, limiter: FailureLimiter, need: Role): Principal {
  const ip = clientIp(event, ctx);
  limiter.assertAllowed(ip);
  const header = getHeader(event, "authorization");
  const cookie = header === undefined ? getCookie(event, SESSION_COOKIE) : undefined;
  const bearer = header === undefined ? undefined : /^Bearer (fr_[A-Za-z0-9_-]+)$/.exec(header)?.[1];
  const token = bearer ?? (cookie && TOKEN_RE.test(cookie) ? cookie : undefined);
  const row = token ? ctx.registry.tokens.verify(token) : null;
  if (!row) {
    // Only count attempts that actually presented credentials, so an anonymous session probe is free.
    if (header !== undefined || cookie !== undefined) limiter.recordFailure(ip);
    throw new ApiError(401, "unauthorized", "missing or invalid API token");
  }
  if (bearer === undefined && !SAFE_METHODS.has(getMethod(event))) assertCsrfHeader(event);
  if (!roleAtLeast(row.role, need)) throw new ApiError(403, "forbidden", `this endpoint requires the ${need} role`);
  return { id: row.id, name: row.name, role: row.role };
}
