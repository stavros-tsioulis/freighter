import { describe, expect, it } from "vitest";
import { checkDomainDns, createDnsResolver, systemDns } from "../src/dns.ts";

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
