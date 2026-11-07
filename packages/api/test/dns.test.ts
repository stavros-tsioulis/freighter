import { describe, expect, it } from "vitest";
import { createDnsResolver, systemDns } from "../src/dns.ts";

describe("createDnsResolver", () => {
  it("uses the system resolver when no servers are given, and a dedicated one otherwise", () => {
    expect(createDnsResolver([])).toBe(systemDns);
    const r = createDnsResolver(["1.1.1.1"]);
    expect(r).not.toBe(systemDns);
    expect(typeof r.resolve4).toBe("function");
  });
  it("answers empty (not an error) when a name has no records or the server can't be reached", async () => {
    const r = createDnsResolver(["127.0.0.1"]); // nothing listens on 53 here
    await expect(r.resolve4("nothing.invalid")).resolves.toEqual([]);
  });
});
