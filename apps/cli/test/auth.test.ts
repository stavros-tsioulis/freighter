import { readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cli, isolated, startApi } from "./harness.ts";

let api: Awaited<ReturnType<typeof startApi>> | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe("sign in", () => {
  it("checks the token, saves a private context, and uses it afterwards", async () => {
    api = await startApi();
    const env = isolated();
    const bad = await cli(["login", api.url], { env, input: "fr_wrong\n" });
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain("error: not signed in, or the token was revoked");

    const ok = await cli(["login", api.url, "--name", "lab"], { env, input: `${api.admin}\n` });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Signed in to 127\.0\.0\.1:\d+ as admin \(admin\)\./);
    expect(statSync(env.FREIGHTER_CONFIG).mode & 0o777).toBe(0o600); // it holds a token
    expect(JSON.parse(readFileSync(env.FREIGHTER_CONFIG, "utf8"))).toMatchObject({ current: "lab", contexts: { lab: { url: api.url, user: "admin", role: "admin" } } });

    const who = await cli(["whoami"], { env });
    expect(who.stdout).toMatch(/admin \(admin\) on 127\.0\.0\.1:\d+/);
    expect((await cli(["whoami", "--json"], { env })).stdout).toContain('"role": "admin"');
  });

  it("is told what to do when there is nothing to sign in to", async () => {
    const r = await cli(["whoami"], { env: isolated() });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("error: not signed in");
    expect(r.stderr).toContain("freighter login <url>");
  });

  it("takes the URL and token from the environment, which win over a saved context", async () => {
    api = await startApi();
    const env = isolated();
    await cli(["login", api.url], { env, input: `${api.admin}\n` });
    const viewer = api.token("viewer");
    const r = await cli(["whoami"], { env: { ...env, ...api.env(viewer) } });
    expect(r.stdout).toMatch(/^viewer \(viewer\)/);
    expect((await cli(["whoami", "--url", api.url], { env })).status).toBe(0); // the saved token is for this URL
    const other = await cli(["whoami", "--url", "http://127.0.0.1:1"], { env: isolated() });
    expect(other.status).toBe(3);
    expect(other.stderr).toContain("--url needs a token");
  });
});

describe("contexts", () => {
  it("lists, switches and removes them, and never prints a token", async () => {
    api = await startApi();
    const env = isolated();
    await cli(["login", api.url, "--name", "prod"], { env, input: `${api.admin}\n` });
    await cli(["login", api.url, "--name", "staging"], { env, input: `${api.token("viewer")}\n` });
    const list = await cli(["context", "list"], { env });
    expect(list.stdout).toMatch(/\*\s+staging/);
    expect(list.stdout).toMatch(/prod/);
    expect(list.stdout).not.toContain("fr_");
    expect((await cli(["context", "list", "--json"], { env })).stdout).not.toContain("fr_");
    expect((await cli(["context", "list", "-q"], { env })).stdout).toBe("prod\nstaging\n");

    expect((await cli(["context", "use", "prod"], { env })).status).toBe(0);
    expect((await cli(["whoami"], { env })).stdout).toMatch(/^admin/);
    expect((await cli(["whoami", "--context", "staging"], { env })).stdout).toMatch(/^viewer/);
    const missing = await cli(["context", "use", "nope"], { env });
    expect(missing.status).toBe(4);
    expect(missing.stderr).toContain('no context named "nope"');

    expect((await cli(["context", "remove", "prod"], { env })).status).toBe(0);
    expect((await cli(["context", "show"], { env })).stdout).toMatch(/^staging/); // another one took its place
    expect((await cli(["logout"], { env })).stdout).toContain("Signed out of staging");
    expect((await cli(["whoami"], { env })).status).toBe(3);
  });
});

describe("how it fails", () => {
  it("says so when the Freighter cannot be reached, and when a command is misused", async () => {
    const env = { ...isolated(), FREIGHTER_URL: "http://127.0.0.1:1", FREIGHTER_TOKEN: "fr_x" };
    const r = await cli(["whoami"], { env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/error: cannot reach http:\/\/127\.0\.0\.1:1/);
    const unknown = await cli(["nonsense"], { env });
    expect(unknown.status).toBe(2);
    expect((await cli(["whoami", "--json"], { env: { ...env, FREIGHTER_URL: "http://127.0.0.1:1" } })).stderr).toContain('"error"');
  });
});
