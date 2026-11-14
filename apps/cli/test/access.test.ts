import { afterEach, describe, expect, it } from "vitest";
import { cli, startApi } from "./harness.ts";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe("tokens", () => {
  it("makes, lists and revokes them, and shows the secret once", async () => {
    api = await startApi();
    const env = api.env(api.admin);
    const made = await cli(["token", "create", "ci-github", "--role", "deployer"], { env });
    expect(made.status).toBe(0);
    const secret = /fr_[A-Za-z0-9_-]{43}/.exec(made.stdout)![0];
    const id = /tok_[0-9a-f]{12}/.exec(made.stdout)![0];
    expect((await cli(["token", "create", "x", "-q"], { env })).stdout.trim()).toMatch(/^fr_/); // -q: only the token
    const list = await cli(["token", "list"], { env });
    expect(list.stdout).toContain(id);
    expect(list.stdout).toMatch(/ci-github\s+deployer\s+never/);
    expect(list.stdout).not.toContain(secret);
    expect((await cli(["token", "create", "x", "--role", "root"], { env })).status).toBe(2);
    expect((await cli(["token", "revoke", id], { env })).status).toBe(1); // asks first
    expect((await cli(["token", "revoke", id, "--yes"], { env })).status).toBe(0);
    expect((await cli(["token", "list"], { env })).stdout).toMatch(/ci-github\s+deployer\s+revoked/);
    expect((await cli(["whoami"], { env: api.env(secret) })).status).toBe(3); // the revoked token is refused
    expect((await cli(["token", "list"], { env: api.env(api.token("deployer")) })).status).toBe(3);
  });
});

describe("registry logins", () => {
  it("saves one from standard input, never an argument, lists it without the password, and removes it", async () => {
    api = await startApi();
    const env = api.env(api.admin);
    expect((await cli(["registry", "add", "ghcr.io", "--username", "me"], { env })).status).toBe(2);
    const add = await cli(["registry", "add", "ghcr.io", "--username", "me", "--password-stdin"], { env, input: "s3cret\n" });
    expect(add.stdout).toContain("Saved the login for ghcr.io (me).");
    expect(api.registry.registryCredentials.secret("ghcr.io", "me")?.password).toBe("s3cret");
    const list = await cli(["registry", "list"], { env });
    expect(list.stdout).toMatch(/ghcr\.io\s+me/);
    expect(list.stdout).not.toContain("s3cret");
    await cli(["registry", "add", "ghcr.io", "--username", "you", "--password-stdin"], { env, input: "pw2\n" });
    expect((await cli(["registry", "remove", "ghcr.io", "--yes"], { env })).stderr).toMatch(/several logins/);
    expect((await cli(["registry", "remove", "ghcr.io", "--username", "you", "--yes"], { env })).stdout).toContain("Removed the login for ghcr.io (you).");
  });
});

describe("ssh keys", () => {
  it("generates and lists them", async () => {
    api = await startApi({ handlers: { "ssh.generate": () => ({ keyType: "ssh-ed25519", publicKey: "ssh-ed25519 AAAAkey freighter:deploy", fingerprint: "SHA256:fp", comment: "freighter:deploy", privateKey: "-----BEGIN-----" }) } });
    const env = api.env(api.admin);
    const gen = await cli(["ssh-key", "generate", "deploy"], { env });
    expect(gen.stdout.trim()).toBe("ssh-ed25519 AAAAkey freighter:deploy");
    const list = await cli(["ssh-key", "list"], { env });
    expect(list.stdout).toMatch(/deploy\s+ssh-ed25519\s+SHA256:fp\s+0/);
    expect(list.stdout).not.toContain("BEGIN");
    expect((await cli(["ssh-key", "remove", "deploy"], { env })).status).toBe(1);
    expect((await cli(["ssh-key", "remove", "deploy", "--yes"], { env })).stdout).toContain("Removed deploy.");
    expect((await cli(["ssh-key", "remove", "ghost", "--yes"], { env })).status).toBe(4);
  });
});

describe("certificates, audit and sync", () => {
  it("lists certificates soonest first, and renews", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
    api = await startApi({ handlers: { "certs.status": () => ({ certs: [{ hostname: "b.example.com", expires: later }, { hostname: "a.example.com", expires: soon }] }), "certs.renew": () => ({ certs: [{ hostname: "a.example.com", issued: true, expires: later }] }) } });
    const env = api.env(api.admin);
    const list = await cli(["cert", "list"], { env });
    expect(list.stdout.split("\n")[1]).toMatch(/^a\.example\.com\s+local\s+\d{4}-\d{2}-\d{2}\s+4|5/);
    expect(list.stdout.split("\n")[2]).toMatch(/^b\.example\.com/);
    expect((await cli(["cert", "renew"], { env })).stdout).toContain("Renewed a.example.com.");
  });

  it("shows who did what, by token name, and filters", async () => {
    api = await startApi({ handlers: { "app.control": () => ({ units: ["u"] }) } });
    api.registry.apps.upsert({ name: "shop", server: "local", manifestText: "name: shop\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    const env = api.env(api.admin);
    await cli(["restart", "shop"], { env });
    await cli(["token", "create", "later"], { env });
    const all = await cli(["audit"], { env });
    expect(all.stdout).toMatch(/WHEN\s+WHO\s+ACTION\s+APP\s+DETAIL/);
    expect(all.stdout).toMatch(/admin\s+service\.restart\s+shop/);
    expect((await cli(["audit", "--app", "shop", "--json"], { env })).stdout).not.toContain("token.create");
    expect((await cli(["audit", "--action", "token", "-n", "1", "--json"], { env })).stdout).toContain("token.create");
    expect((await cli(["audit", "--who", "nobody"], { env })).stdout).not.toContain("service.restart");
    expect((await cli(["audit"], { env: api.env(api.token("deployer")) })).status).toBe(3);
  });

  it("syncs", async () => {
    api = await startApi({ handlers: { "apps.list": () => ({ apps: [] }) } });
    expect((await cli(["sync"], { env: api.env(api.admin) })).status).toBe(0);
  });
});
