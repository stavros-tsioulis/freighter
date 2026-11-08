import { describe, expect, it } from "vitest";
import { checkDomainDns, type ChallengeProbe, createDnsResolver, systemDns } from "../src/dns.ts";

describe("createDnsResolver", () => {
  it("uses the system resolver when no servers are given, and a dedicated one otherwise", () => {
    expect(createDnsResolver([])).toBe(systemDns);
    const r = createDnsResolver(["1.1.1.1"]);
    expect(r).not.toBe(systemDns);
    expect(typeof r.resolve4).toBe("function");
  });
  it("answers empty when a name has no records, even if the chosen server can't be reached (the system resolver answers)", async () => {
    const r = createDnsResolver(["127.0.0.1"]); // nothing listens on 53 here
    await expect(r.resolve4("nothing.invalid")).resolves.toEqual([]);
  });
});

describe("checkDomainDns", () => {
  it("says why when the lookup itself fails, instead of claiming the name does not resolve", async () => {
    const broken = { resolve4: () => Promise.reject(new Error("couldn't reach the DNS server 1.1.1.1 (ETIMEOUT)")), resolve6: () => Promise.resolve([]) };
    const r = await checkDomainDns(broken, "blog.example.com", ["203.0.113.7"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Could not look up blog\.example\.com: couldn't reach the DNS server 1\.1\.1\.1 \(ETIMEOUT\)/);
  });
  it("still tells a missing record from a wrong one", async () => {
    const none = { resolve4: () => Promise.resolve([]), resolve6: () => Promise.resolve([]) };
    expect((await checkDomainDns(none, "blog.example.com", ["203.0.113.7"])).reason).toMatch(/doesn't resolve yet/);
    const other = { resolve4: () => Promise.resolve(["198.51.100.1"]), resolve6: () => Promise.resolve([]) };
    expect((await checkDomainDns(other, "blog.example.com", ["203.0.113.7"])).reason).toMatch(/resolves to 198\.51\.100\.1/);
  });
});

describe("checkDomainDns behind Cloudflare's proxy", () => {
  const resolver = (ips: string[]) => ({ resolve4: () => Promise.resolve(ips), resolve6: () => Promise.resolve([]) });
  const probe = (answer: { status: number; text: string } | Error, token = "tok"): ChallengeProbe => ({
    token: async () => token,
    fetch: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  it("accepts a proxied hostname when it answers with this server's token", async () => {
    const r = await checkDomainDns(resolver(["104.21.5.9", "172.67.1.1"]), "blog.example.com", ["203.0.113.7"], probe({ status: 200, text: "tok\n" }));
    expect(r).toMatchObject({ ok: true, method: "http", cloudflare: true });
  });
  it("does not need the HTTP check when the records point straight at the server", async () => {
    const never: ChallengeProbe = { token: () => Promise.reject(new Error("asked")), fetch: () => Promise.reject(new Error("fetched")) };
    expect(await checkDomainDns(resolver(["203.0.113.7"]), "blog.example.com", ["203.0.113.7"], never)).toMatchObject({ ok: true, method: "dns", cloudflare: false });
  });
  it("rejects a proxied hostname that reaches another server", async () => {
    const r = await checkDomainDns(resolver(["104.21.5.9"]), "blog.example.com", ["203.0.113.7"], probe({ status: 200, text: "someone else's token" }));
    expect(r.ok).toBe(false);
    expect(r.cloudflare).toBe(true);
    expect(r.reason).toMatch(/proxied by Cloudflare.*not from this server/);
  });
  it("explains Cloudflare's 52x errors and unreachable origins", async () => {
    expect((await checkDomainDns(resolver(["104.21.5.9"]), "a.example.com", ["203.0.113.7"], probe({ status: 522, text: "" }))).reason).toMatch(/HTTP 522/);
    expect((await checkDomainDns(resolver(["104.21.5.9"]), "a.example.com", ["203.0.113.7"], probe(new Error("timeout")))).reason).toMatch(/no HTTP answer \(timeout\)/);
  });
  it("still fails when the server can't be asked for its token (an older agent)", async () => {
    const old: ChallengeProbe = { token: () => Promise.reject(new Error("unknown operation")), fetch: () => Promise.reject(new Error("unused")) };
    expect((await checkDomainDns(resolver(["104.21.5.9"]), "a.example.com", ["203.0.113.7"], old)).reason).toMatch(/check token/);
  });
  it("never lets the HTTP check excuse a stray non-Cloudflare record", async () => {
    const r = await checkDomainDns(resolver(["104.21.5.9", "198.51.100.1"]), "a.example.com", ["203.0.113.7"], probe({ status: 200, text: "tok" }));
    expect(r).toMatchObject({ ok: false, cloudflare: false });
    expect(r.reason).toMatch(/resolves to/);
  });
});
