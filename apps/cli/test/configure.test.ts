import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cli, startApi } from "./harness.ts";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const YAML = `name: shop
services:
  web:
    command: node web.mjs
    port: 3000
    environment:
      LOG_LEVEL: info
      API_URL: "@api.url"
    secrets:
      - DATABASE_URL
      - SENTRY_DSN
  api:
    command: node api.mjs
    port: 3001
environment:
  TZ: UTC
`;

let n = 0;
async function setup(extra: Record<string, (a: any) => unknown> = {}) {
  let current = YAML;
  api = await startApi({
    handlers: {
      "app.config.get": () => ({ manifestText: current }),
      "app.config.set": (a: { manifestText: string }) => {
        current = a.manifestText;
        return { deploy: null };
      },
      "connections.set": () => ({}),
      "variables.get": () => ({ variables: {} }),
      "domains.get": () => ({ domains: [] }),
      "env.list": () => ({ names: ["DATABASE_URL"] }),
      "env.set": () => ({}),
      "volumes.status": () => ({ volumes: { media: { type: "smb", state: "mounted", password: true }, backup: { type: "nfs", state: "failed", password: null } } }),
      "volumes.password.set": () => ({}),
      ...extra,
    },
  });
  api.registry.apps.upsert({ name: "shop", server: "local", manifestText: YAML, currentRelease: "r1", previousRelease: null, status: "deployed" });
  api.registry.services.replace("shop", ["web", "api"].map((name) => ({ name, unit: `u-${name}`, port: 3000, hostnames: [], activeState: "active", subState: "running", restarts: 0, memoryBytes: 1 })));
  return { env: { ...api.env(api.admin), FREIGHTER_POLL_MS: "50" }, current: () => current };
}
const file = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "freighter-cli-cfg-")), "app.yaml");
  writeFileSync(f, text);
  return f;
};

describe("config", () => {
  it("shows the configuration, as app.yaml", async () => {
    const { env } = await setup();
    const r = await cli(["config", "show", "shop"], { env });
    expect(r.stdout).toContain("name: shop");
    expect(r.stdout).toContain("LOG_LEVEL: info");
    expect(JSON.parse((await cli(["config", "show", "shop", "--json"], { env })).stdout)).toMatchObject({ app: "shop", settings: { services: { web: { port: 3000 } } } });
    expect((await cli(["config", "show", "ghost"], { env })).status).toBe(4);
  });

  it("shows what applying a file would change, and applies it", async () => {
    const { env, current } = await setup();
    const changed = file(YAML.replace("LOG_LEVEL: info", "LOG_LEVEL: debug"));
    const diff = await cli(["config", "diff", "-f", changed], { env });
    expect(diff.status).toBe(0);
    expect(diff.stdout).toMatch(/^- .*LOG_LEVEL: info$/m);
    expect(diff.stdout).toMatch(/^\+ .*LOG_LEVEL: debug$/m);
    expect((await cli(["config", "diff", "-f", file(YAML)], { env })).stdout).toContain("No changes.");

    const applied = await cli(["config", "apply", "shop", "-f", changed], { env });
    expect(applied.status).toBe(0);
    expect(applied.stderr).toContain("Applying");
    expect(current()).toContain("LOG_LEVEL: debug");
    const other = await cli(["config", "apply", "other", "-f", changed], { env });
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('is for "shop", not "other"');
    expect((await cli(["config", "apply", "-f", "/nonexistent.yaml"], { env })).status).toBe(4);
    expect((await cli(["config", "apply", "-f", file("name: shop\nservices: {}\n")], { env })).status).toBe(1);
  });
});

describe("variables", () => {
  it("lists them with where each comes from, and what connections resolve to", async () => {
    const { env } = await setup();
    api!.handlers["domains.get"] = () => ({ domains: [{ hostname: "api.example.com", service: "api", tls: "auto" }] });
    const r = await cli(["var", "list", "shop/web"], { env });
    expect(r.stdout).toMatch(/KEY\s+VALUE\s+FROM/);
    expect(r.stdout).toMatch(/LOG_LEVEL\s+info\s+service/);
    expect(r.stdout).toMatch(/TZ\s+UTC\s+app/);
    const resolved = await cli(["var", "list", "shop/web", "--resolved"], { env });
    expect(resolved.stdout).toMatch(/API_URL\s+@api\.url\s+service\s+https:\/\/api\.example\.com/);
    expect((await cli(["var", "list", "shop"], { env })).stdout).toMatch(/SERVICE\s+KEY/);
  });

  it("sets and removes a service's own variables, and the app's and the build's", async () => {
    const { env, current } = await setup();
    const set = await cli(["var", "set", "shop/web", "LOG_LEVEL=debug", "MODE=fast"], { env });
    expect(set.status).toBe(0);
    expect(current()).toMatch(/LOG_LEVEL: debug/);
    expect(current()).toMatch(/MODE: fast/);
    expect((await cli(["var", "unset", "shop/web", "MODE"], { env })).status).toBe(0);
    expect(current()).not.toMatch(/MODE:/);

    expect((await cli(["var", "set", "shop", "REGION=eu"], { env })).status).toBe(0); // no service: the app-level environment
    expect(current()).toMatch(/environment:\n  TZ: UTC\n  REGION: eu|REGION: eu/);
    expect((await cli(["var", "unset", "shop", "REGION"], { env })).status).toBe(0);
    expect(current()).not.toMatch(/REGION/);

    const build = await cli(["var", "set", "shop", "--build", "NODE_ENV=production"], { env });
    expect(build.status).toBe(2);
    expect(build.stderr).toContain("no build section");

    expect((await cli(["var", "set", "shop/web", "lower=x"], { env })).status).toBe(2);
    expect((await cli(["var", "set", "shop/web", "NOEQUALS"], { env })).status).toBe(2);
    expect((await cli(["var", "set", "shop/web"], { env })).status).toBe(2);
    expect((await cli(["var", "set", "shop/web", "PORT=1"], { env })).status).toBe(1); // PORT is Freighter's
  });
});

describe("secrets", () => {
  it("lists names and whether they have a value, and sets one from standard input", async () => {
    const { env } = await setup();
    const list = await cli(["secret", "list", "shop/web"], { env });
    expect(list.stdout).toMatch(/DATABASE_URL\s+yes/);
    expect(list.stdout).toMatch(/SENTRY_DSN\s+no/);
    expect(list.stdout).not.toContain("postgres://");
    const set = await cli(["secret", "set", "shop/web", "SENTRY_DSN", "--stdin"], { env, input: "https://key@sentry.example/1\n" });
    expect(set.status).toBe(0);
    expect(set.stdout).toContain("freighter redeploy shop");
    expect(api!.calls.find((c) => c.op === "env.set")!.args).toEqual({ app: "shop", service: "web", key: "SENTRY_DSN", value: "https://key@sentry.example/1" });
    expect(JSON.stringify(api!.registry.audit.list())).not.toContain("sentry.example"); // never the value

    const inline = await cli(["secret", "set", "shop/web", "SENTRY_DSN=oops"], { env });
    expect(inline.status).toBe(2);
    expect(inline.stderr).toContain("never an argument");
    const noTerminal = await cli(["secret", "set", "shop/web", "SENTRY_DSN"], { env });
    expect(noTerminal.status).toBe(2);
    expect(noTerminal.stderr).toContain("--stdin");
    expect((await cli(["secret", "set", "shop", "SENTRY_DSN", "--stdin"], { env, input: "x" })).stderr).toContain("which service of shop");
  });
});

describe("domains", () => {
  it("adds one and prints the DNS records, verifies it, and removes it", async () => {
    const { env } = await setup();
    const add = await cli(["domain", "add", "shop", "shop.example.com", "--service", "web"], { env });
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("Added shop.example.com to shop/web");
    expect(add.stdout).toMatch(/A\s+shop\.example\.com\s+203\.0\.113\.7/);
    expect(add.stdout).toContain("freighter domain verify shop shop.example.com");
    const list = await cli(["domain", "list", "shop"], { env });
    expect(list.stdout).toMatch(/shop\.example\.com\s+web\s+automatic\s+waiting for DNS/);
    expect((await cli(["domain", "add", "shop", "x.example.com"], { env })).stderr).toContain("which service of shop");

    const early = await cli(["domain", "verify", "shop", "shop.example.com"], { env });
    expect(early.status).toBe(1);
    expect(early.stderr).toMatch(/shop\.example\.com isn't ready/);
    expect((await cli(["domain", "remove", "shop", "shop.example.com"], { env })).stdout).toContain("Removed shop.example.com from shop.");
    expect((await cli(["domain", "list", "shop"], { env })).stderr).toContain("no domains");
  });
});

describe("volumes", () => {
  it("lists remote volumes and sets a password from standard input", async () => {
    const { env } = await setup();
    const list = await cli(["volume", "list", "shop"], { env });
    expect(list.stdout).toMatch(/media\s+smb\s+mounted\s+set/);
    expect(list.stdout).toMatch(/backup\s+nfs\s+failed/);
    const pw = await cli(["volume", "password", "shop", "media", "--stdin"], { env, input: "s3cret\n" });
    expect(pw.status).toBe(0);
    expect(api!.calls.find((c) => c.op === "volumes.password.set")!.args).toEqual({ app: "shop", name: "media", password: "s3cret" });
  });
});

describe("git", () => {
  it("links an app, shows the link, and unlinks it", async () => {
    const { env } = await setup({ "git.keygen": () => ({ publicKey: "ssh-ed25519 AAAAcli freighter:shop", fingerprint: "SHA256:cli" }), "git.check": () => ({ sha: "a".repeat(40) }) });
    const link = await cli(["git", "link", "shop", "git@github.com:org/shop.git", "--branch", "main"], { env });
    expect(link.status).toBe(0);
    expect(link.stdout).toContain("Linked shop to git@github.com:org/shop.git");
    expect(link.stdout).toContain("ssh-ed25519 AAAAcli");
    expect(link.stdout).toMatch(/Secret\s+\S+/);
    const show = await cli(["git", "show", "shop"], { env });
    expect(show.stdout).toMatch(/repository\s+git@github\.com:org\/shop\.git/);
    expect((await cli(["git", "check", "shop"], { env })).stdout).toContain("the branch is at aaaaaaaaaaaa");
    expect((await cli(["git", "rotate-secret", "shop", "-q"], { env })).stdout.trim()).toMatch(/\S{20,}/);
    expect((await cli(["git", "unlink", "shop"], { env })).status).toBe(1); // asks first
    expect((await cli(["git", "unlink", "shop", "--yes"], { env })).stdout).toContain("Unlinked shop.");
    expect((await cli(["git", "show", "shop"], { env })).status).toBe(4);
  });
});
