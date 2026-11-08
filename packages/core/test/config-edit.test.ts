import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELDS, SettingsError, applySettings, readSettings } from "../src/config-edit.ts";
import { hostConfigSchema } from "../src/config.ts";

const tmp = async (content?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "fr-cfg-"));
  const path = join(dir, "config.yaml");
  if (content !== undefined) await writeFile(path, content);
  return path;
};

describe("settings catalogue", () => {
  it("only names keys that exist in the config schema, with the right defaults", async () => {
    const fields = await readSettings(await tmp());
    expect(fields).toHaveLength(FIELDS.length);
    const defaults = hostConfigSchema.parse({});
    for (const f of fields) expect(f.explicit).toBe(false);
    expect(fields.find((f) => f.key === "haproxy.httpPort")).toMatchObject({ value: 80, default: 80 });
    expect(fields.find((f) => f.key === "acme.email")).toMatchObject({ value: null, explicit: false });
    expect(defaults.acme.renewBeforeDays).toBe(30);
  });

  it("reports what the file sets", async () => {
    const fields = await readSettings(await tmp("acme:\n  email: ops@example.com\nhaproxy:\n  httpPort: 4080\n"));
    expect(fields.find((f) => f.key === "acme.email")).toMatchObject({ value: "ops@example.com", explicit: true });
    expect(fields.find((f) => f.key === "haproxy.httpPort")).toMatchObject({ value: 4080, default: 80, explicit: true });
  });
});

describe("applySettings", () => {
  it("keeps comments and unrelated keys, and says what to restart", async () => {
    const path = await tmp("# my server\nacme:\n  email: old@example.com   # contact\nagent:\n  remote:\n    enabled: true\n");
    const r = await applySettings(path, { "acme.email": "new@example.com", "drainSeconds": 10 });
    const text = await readFile(path, "utf8");
    expect(text).toContain("# my server");
    expect(text).toContain("# contact");
    expect(text).toContain("email: new@example.com");
    expect(text).toContain("enabled: true");
    expect(r.changed.sort()).toEqual(["acme.email", "drainSeconds"]);
    expect(r.restart).toEqual(["agent"]);
    expect(await readFile(`${path}.bak`, "utf8")).toContain("old@example.com");
  });

  it("creates the file when there is none, and removes an entry (and its empty parent) when reset", async () => {
    const path = await tmp();
    await applySettings(path, { "haproxy.httpPort": 4080 });
    expect(await readFile(path, "utf8")).toContain("httpPort: 4080");
    const r = await applySettings(path, { "haproxy.httpPort": null });
    expect(r.changed).toEqual(["haproxy.httpPort"]);
    expect((await readFile(path, "utf8")).trim()).toBe("{}");
  });

  it("flags listener changes for HAProxy, and leaves control-plane settings to need no restart", async () => {
    const path = await tmp();
    const r = await applySettings(path, { "api.publicUrl": "https://f.example.com", "haproxy.httpsPort": 4443 });
    expect(r.restart).toEqual([]);
    expect(r.haproxyChanged).toBe(true);
  });

  it("writes nothing when nothing changed", async () => {
    const path = await tmp("drainSeconds: 5\n");
    const r = await applySettings(path, { drainSeconds: 5 });
    expect(r.changed).toEqual([]);
  });

  it("rejects bad input without touching the file", async () => {
    const path = await tmp("drainSeconds: 5\n");
    await expect(applySettings(path, { "acme.email": "not-an-email" })).rejects.toThrow(/acme\.email/);
    await expect(applySettings(path, { drainSeconds: -1 })).rejects.toThrow(/at least 0/);
    await expect(applySettings(path, { drainSeconds: "ten" })).rejects.toThrow(SettingsError);
    await expect(applySettings(path, { "pki.dir": "/x" })).rejects.toThrow(/not a setting/);
    await expect(applySettings(path, { "haproxy.httpPort": 443 })).rejects.toThrow(/must be different/);
    await expect(applySettings(path, { "ports.min": 30000 })).rejects.toThrow(/ports/);
    await expect(applySettings(path, { "api.publicUrl": "x" }, { allow: (f) => f.scope === "agent" })).rejects.toThrow(/not available/);
    expect(await readFile(path, "utf8")).toBe("drainSeconds: 5\n");
  });

  it("refuses to edit a file that is not valid YAML", async () => {
    await expect(applySettings(await tmp("acme: [\n"), { drainSeconds: 1 })).rejects.toThrow(/not valid YAML/);
  });
});
