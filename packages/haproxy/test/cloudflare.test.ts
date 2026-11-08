import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureChallengeToken, isCloudflareIp } from "../src/index.ts";

describe("isCloudflareIp", () => {
  it("knows Cloudflare's IPv4 and IPv6 ranges", () => {
    for (const ip of ["104.21.5.9", "172.67.1.1", "188.114.97.3", "162.159.0.1", "2606:4700:3030::6815:1", "2a06:98c1::1"]) expect(isCloudflareIp(ip), ip).toBe(true);
  });
  it("rejects everything else, including garbage", () => {
    for (const ip of ["203.0.113.7", "8.8.8.8", "104.32.0.1", "2001:db8::1", "not an ip", ""]) expect(isCloudflareIp(ip), ip).toBe(false);
  });
});

describe("ensureChallengeToken", () => {
  it("creates a token once and keeps returning it", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "freighter-ct-")), "haproxy");
    const a = await ensureChallengeToken(dir);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await ensureChallengeToken(dir)).toBe(a);
  });
});
