import { describe, expect, it } from "vitest";
import { parseHostConfig } from "@freighter/core/config";
import { openRegistry } from "@freighter/registry";
import { createControlSettings, envVarFor } from "../src/control-settings.ts";
import type { ApiContext } from "../src/context.ts";

const make = (opts: { env?: NodeJS.ProcessEnv; file?: unknown } = {}) => {
  const registry = openRegistry(":memory:");
  const target = { registry, trustProxy: true, maxUploadBytes: 0 } as unknown as ApiContext;
  const warnings: string[] = [];
  const s = createControlSettings({ registry, file: parseHostConfig({ api: opts.file ?? {} }).api, target, env: opts.env, warn: (m) => warnings.push(m) });
  return { registry, target, s, warnings };
};
const field = (s: ReturnType<typeof make>["s"], key: string) => s.list().find((f) => f.key === key)!;

describe("control settings layers", () => {
  it("names environment variables after the setting", () => {
    expect(envVarFor("api.dnsServers")).toBe("FREIGHTER_API_DNS_SERVERS");
    expect(envVarFor("api.maxUploadMb")).toBe("FREIGHTER_API_MAX_UPLOAD_MB");
    expect(envVarFor("api.publicUrl")).toBe("FREIGHTER_API_PUBLIC_URL");
  });

  it("applies the defaults to the running context", () => {
    const { target } = make();
    expect(target.maxUploadBytes).toBe(200 * 1024 * 1024);
    expect(target.trustProxy).toBe(true);
    expect(target.publicIps).toEqual([]);
  });

  it("uses config.yaml over the default, the dashboard over config.yaml, the environment over both", () => {
    const m = make({ file: { maxUploadMb: 50 }, env: { FREIGHTER_API_PUBLIC_URL: "https://env.example.com" } });
    expect(field(m.s, "api.maxUploadMb")).toMatchObject({ value: 50, source: "file", explicit: true });
    m.s.set({ "api.maxUploadMb": 75 });
    expect(field(m.s, "api.maxUploadMb")).toMatchObject({ value: 75, source: "dashboard" });
    expect(m.target.maxUploadBytes).toBe(75 * 1024 * 1024);
    expect(field(m.s, "api.publicUrl")).toMatchObject({ value: "https://env.example.com", source: "env", envVar: "FREIGHTER_API_PUBLIC_URL" });
    expect(m.target.publicUrl).toBe("https://env.example.com");
    m.s.set({ "api.maxUploadMb": null });
    expect(field(m.s, "api.maxUploadMb")).toMatchObject({ value: 50, source: "file" });
  });

  it("refuses to change a setting the environment fixes", () => {
    const m = make({ env: { FREIGHTER_API_PUBLIC_URL: "https://env.example.com" } });
    expect(() => m.s.set({ "api.publicUrl": "https://other.example.com" })).toThrow(/FREIGHTER_API_PUBLIC_URL/);
    expect(m.registry.settings.all()).toEqual({});
  });

  it("reads lists, numbers and booleans from the environment, and ignores bad values with a warning", () => {
    const m = make({ env: { FREIGHTER_API_DNS_SERVERS: "", FREIGHTER_API_PUBLIC_IPS: "203.0.113.7, 203.0.113.8", FREIGHTER_API_SYNC_SECONDS: "30", FREIGHTER_API_TRUST_PROXY: "false", FREIGHTER_API_MAX_UPLOAD_MB: "lots" } });
    expect(m.s.current()).toMatchObject({ dnsServers: [], publicIps: ["203.0.113.7", "203.0.113.8"], syncSeconds: 30, trustProxy: false, maxUploadMb: 200 });
    expect(m.target.trustProxy).toBe(false);
    expect(m.warnings.join()).toMatch(/FREIGHTER_API_MAX_UPLOAD_MB ignored/);
  });

  it("validates the whole result and keeps nothing when it is invalid", () => {
    const m = make();
    expect(() => m.s.set({ "api.publicIps": ["nope"] })).toThrow();
    expect(() => m.s.set({ "api.publicUrl": "nope" })).toThrow();
    expect(() => m.s.set({ drainSeconds: 3 })).toThrow(/not a setting of the control server/);
    expect(m.registry.settings.all()).toEqual({});
    expect(m.s.current().publicIps).toEqual([]);
  });

  it("restores saved settings when the process starts again", () => {
    const m = make();
    m.s.set({ "api.dnsServers": [], "api.syncSeconds": 5 });
    const again = createControlSettings({ registry: m.registry, file: parseHostConfig({}).api, target: { registry: m.registry } as unknown as ApiContext });
    expect(again.current()).toMatchObject({ dnsServers: [], syncSeconds: 5 });
  });
});
