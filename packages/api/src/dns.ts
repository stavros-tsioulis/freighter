import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/** The slice of DNS the domain check needs (replaceable in tests). */
export interface DnsResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

/** "There is no such record": a real answer, as opposed to a lookup that could not be made. */
const MISSING = new Set(["ENOTFOUND", "ENODATA"]);
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? "";
const orEmpty = (p: Promise<string[]>) =>
  p.catch((e) => {
    if (MISSING.has(code(e))) return [] as string[];
    throw e;
  });

/** What the operating system's resolver (getaddrinfo) says, for hosts where direct DNS queries don't get out. */
async function viaSystem(host: string, family: 4 | 6): Promise<string[]> {
  try {
    return (await dns.lookup(host, { family, all: true })).map((a) => a.address);
  } catch (e) {
    if (MISSING.has(code(e))) return [];
    throw e;
  }
}

/** Real lookups, following CNAMEs. A missing record is an empty answer; a lookup that can't be made is an error. */
export const systemDns: DnsResolver = {
  resolve4: (h) => orEmpty(dns.resolve4(h)).catch(() => viaSystem(h, 4)),
  resolve6: (h) => orEmpty(dns.resolve6(h)).catch(() => viaSystem(h, 6)),
};

/**
 * Lookups through specific servers, e.g. public resolvers, so a stale cache in the local network or container
 * doesn't make a correct DNS setup look wrong. When those servers can't be reached (some hosts only allow their own
 * resolver) the system's resolver answers instead. An empty list means the system's resolver.
 */
export function createDnsResolver(servers: readonly string[]): DnsResolver {
  if (servers.length === 0) return systemDns;
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  r.setServers([...servers]);
  const through = (ask: (h: string) => Promise<string[]>, fallback: (h: string) => Promise<string[]>) => (h: string) =>
    orEmpty(ask(h)).catch(async (e) => {
      try {
        return await fallback(h);
      } catch {
        throw new Error(`couldn't reach the DNS server${servers.length > 1 ? "s" : ""} ${servers.join(", ")} (${code(e) || (e as Error).message}), and the system resolver failed too`);
      }
    });
  return {
    resolve4: through((h) => r.resolve4(h), systemDns.resolve4),
    resolve6: through((h) => r.resolve6(h), systemDns.resolve6),
  };
}

export async function resolveAll(r: DnsResolver, host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const [a, aaaa] = await Promise.all([r.resolve4(host), r.resolve6(host)]);
  return [...new Set([...a, ...aaaa])];
}

/** `localhost` and `*.localhost` always mean this machine (RFC 6761): nothing to set up in DNS. */
export const isLocalName = (host: string) => host === "localhost" || host.endsWith(".localhost");

export const isPrivateOrLoopback = (ip: string) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip) || ip === "::1" || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);

export interface DnsCheck {
  ok: boolean;
  /** What the hostname resolves to right now. */
  found: string[];
  /** The addresses it should resolve to (this server's). */
  expected: string[];
  reason: string | null;
}

/** The hostname must resolve, and only to this server: a stray record elsewhere would send some visitors away. */
export async function checkDomainDns(r: DnsResolver, hostname: string, expected: string[]): Promise<DnsCheck> {
  if (isLocalName(hostname)) return { ok: true, found: ["127.0.0.1"], expected: ["127.0.0.1"], reason: null };
  let found: string[];
  try {
    found = await resolveAll(r, hostname);
  } catch (e) {
    return { ok: false, found: [], expected, reason: `Could not look up ${hostname}: ${e instanceof Error ? e.message : String(e)}.` };
  }
  const fail = (reason: string): DnsCheck => ({ ok: false, found, expected, reason });
  if (expected.length === 0) {
    return fail("Freighter doesn't know this server's public IP address. Set api.publicIps in /etc/freighter/config.yaml, then verify again.");
  }
  if (found.length === 0) return fail(`${hostname} doesn't resolve yet. DNS changes can take a few minutes to spread.`);
  const stray = found.filter((ip) => !expected.includes(ip));
  if (stray.length > 0) {
    return fail(`${hostname} resolves to ${found.join(", ")}, but this server is ${expected.join(", ")}.${stray.length < found.length ? " Remove the other records." : ""}`);
  }
  return { ok: true, found, expected, reason: null };
}
