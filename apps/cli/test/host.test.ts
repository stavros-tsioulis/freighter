import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliPath, hello } from "./harness.ts";

const run = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", cwd: join(import.meta.dirname, "..") });
const prefix = () => mkdtempSync(join(tmpdir(), "freighter-cli-host-"));

describe("validate", () => {
  it("checks an app.yaml with no server and no sign-in", () => {
    expect(run("validate", `${hello}/app.yaml`).stdout).toContain("ok: hello (web)");
    const missing = run("validate", "/nonexistent.yaml");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("cannot read manifest");
  });
});

describe("freighter host", () => {
  it("prints the unit it would write for a service", () => {
    expect(run("host", "unit", "web", "-f", `${hello}/app.yaml`).stdout).toContain("ExecStart=/usr/bin/env node server.mjs");
    expect(run("host", "unit", "nope", "-f", `${hello}/app.yaml`).stderr).toContain('unknown service "nope"');
  });

  it("deploys into a prefix, and an image-only app without an archive", () => {
    const p = prefix();
    const d = run("host", "deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", p);
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/deployed hello as r\d{8}-\d{6}/);
    expect(readlinkSync(`${p}/srv/apps/hello/current`)).toMatch(/^releases\/r/);

    const dir = mkdtempSync(join(tmpdir(), "freighter-img-"));
    const file = join(dir, "app.yaml");
    writeFileSync(file, "name: shop\nservices:\n  web:\n    image: ghcr.io/org/shop:1\n    port: 3000\n    containerPort: 8080\n");
    const img = run("host", "deploy", "-f", file, "--prefix", p);
    expect(img.stdout).toMatch(/deployed shop as r\d{8}-\d{6}/);
    expect(readFileSync(`${p}/srv/apps/shop/current/.freighter-images.json`, "utf8")).toContain("ghcr.io/org/shop:1");
    expect(run("host", "deploy", "-f", `${hello}/app.yaml`, "--prefix", p).stderr).toContain("an artifact is required");
    expect(run("host", "deploy", hello, "-f", `${hello}/app.yaml`).stderr).toContain("must run as root"); // not under a prefix, not root
  });

  it("prints the HAProxy setup snippet and checks certificates", () => {
    const p = prefix();
    const out = run("host", "haproxy", "setup", "--prefix", p).stdout;
    expect(out).toContain("use_backend freighter_acme if freighter_acme");
    expect(out).toContain(`bind :443 ssl crt ${p}/etc/haproxy/freighter/certs/`);
    expect(run("host", "certs", "status", "--prefix", p).stdout).toContain("no tls: auto domains");
    expect(run("host", "haproxy", "sync", "--prefix", p).stdout).toContain("0 route(s)");
  });

  it("makes the first token in the registry, and refuses a role that doesn't exist", () => {
    const p = prefix();
    const made = run("host", "token", "create", "ci", "--role", "deployer", "--prefix", p);
    expect(made.status).toBe(0);
    expect(made.stdout).toMatch(/tok_[0-9a-f]{12}\s+deployer\s+ci/);
    expect(made.stdout).toMatch(/fr_[A-Za-z0-9_-]{43}/);
    expect(run("host", "token", "create", "x", "--role", "root", "--prefix", p).stderr).toContain("invalid role");
  });

  it("deletes an app from this server, and won't without --yes when there is nobody to ask", () => {
    const p = prefix();
    expect(run("host", "deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", p).status).toBe(0);
    const refused = run("host", "app", "delete", "hello", "--prefix", p);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
    expect(existsSync(`${p}/srv/apps/hello`)).toBe(true);
    const gone = run("host", "app", "delete", "hello", "--yes", "--prefix", p);
    expect(gone.status).toBe(0);
    expect(gone.stdout).toContain("deleted hello");
    expect(existsSync(`${p}/srv/apps/hello`)).toBe(false);
    expect(run("host", "app", "delete", "hello", "--yes", "--prefix", p).stderr).toContain('unknown app "hello"');
    expect(run("host", "app", "delete", "Bad Name", "--yes", "--prefix", p).stderr).toContain("invalid app name");
  });
});
