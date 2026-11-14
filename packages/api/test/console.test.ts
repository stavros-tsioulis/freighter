import { describe, expect, it } from "vitest";
import { ApiError, openConsole, type ConsoleRequest, type ConsoleSink } from "../src/index.ts";
import { makeApi } from "./helpers.ts";

const APP = "name: shop\nservices:\n  web:\n    command: node web.mjs\n";

async function setup() {
  const t = await makeApi();
  t.registry.apps.upsert({ name: "shop", server: "local", manifestText: APP, currentRelease: "r1", previousRelease: null, status: "deployed" });
  const out = { data: [] as string[], stderr: [] as string[], exits: [] as number[], errors: [] as string[], closed: 0 };
  const sink: ConsoleSink = {
    data: (c) => out.data.push(c.toString()),
    stderr: (c) => out.stderr.push(c.toString()),
    exit: (c) => out.exits.push(c),
    error: (m) => out.errors.push(m),
    closed: () => void out.closed++,
  };
  const req = (o: { token?: string; cookie?: string; origin?: string; host?: string; query?: string } = {}): ConsoleRequest => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = `fr_session=${o.cookie}`;
    if (o.origin) headers.origin = o.origin;
    headers.host = o.host ?? "freighter.example.com";
    return { url: `/_console?${o.query ?? "app=shop&service=web&cols=100&rows=30"}`, header: (n) => headers[n.toLowerCase()], ip: "198.51.100.9" };
  };
  return { t, out, sink, req };
}
const refusal = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ApiError | null;

describe("console sessions", () => {
  it("opens a shell for an admin, passes bytes both ways, and tells the audit log", async () => {
    const { t, out, sink, req } = await setup();
    const handle = await openConsole(t.ctx, req({ token: t.tokens.admin }), sink);
    const session = t.consoles[0]!;
    expect(session.args).toEqual({ app: "shop", service: "web", cols: 100, rows: 30, tty: true });
    expect(handle.info).toMatchObject({ kind: "host", user: "shop" });

    handle.write("ls\n");
    handle.resize(120, 40);
    expect(session.written).toEqual(["ls\n"]);
    expect(session.resized).toEqual([[120, 40]]);
    session.say("file.txt\r\n");
    session.warn("closed after 30 minutes without input");
    session.errput("warn\n");
    session.finish(0);
    expect(out).toMatchObject({ data: ["file.txt\r\n"], errors: ["closed after 30 minutes without input"], exits: [0], stderr: ["warn\n"] });

    handle.close();
    expect(out.closed).toBe(1);
    const log = t.registry.audit.list().map((a) => a.action);
    expect(log).toEqual(expect.arrayContaining(["console.open", "console.close"]));
    const opened = t.registry.audit.list().find((a) => a.action === "console.open")!;
    expect(opened.detail).toMatchObject({ service: "web", kind: "host", ip: "198.51.100.9" });
  });

  it("runs a command without a terminal, with extra variables, and says only its name in the audit log", async () => {
    const { t, out, sink, req } = await setup();
    const cmd = encodeURIComponent(JSON.stringify(["/usr/bin/psql", "-c", "select 'secret-arg'"]));
    const env = encodeURIComponent(JSON.stringify({ PGDATABASE: "shop" }));
    const handle = await openConsole(t.ctx, req({ token: t.tokens.admin, query: `app=shop&service=web&cmd=${cmd}&tty=0&env=${env}` }), sink);
    expect(t.consoles[0]!.args).toMatchObject({ command: ["/usr/bin/psql", "-c", "select 'secret-arg'"], tty: false, env: { PGDATABASE: "shop" } });
    handle.end();
    expect(t.consoles[0]!.ended).toBe(true);
    const opened = t.registry.audit.list().find((a) => a.action === "console.open")!;
    expect(opened.detail).toMatchObject({ command: "psql" });
    expect(JSON.stringify(opened.detail)).not.toContain("secret-arg");
    expect((await refusal(openConsole(t.ctx, req({ token: t.tokens.admin, query: "app=shop&service=web&cmd=notjson" }), sink)))?.status).toBe(400);
    expect((await refusal(openConsole(t.ctx, req({ token: t.tokens.admin, query: `app=shop&service=web&env=${encodeURIComponent('{"bad name":"x"}')}` }), sink)))?.status).toBe(400);
    void out;
  });

  it("is for admins only, and needs a valid token", async () => {
    const { t, sink, req } = await setup();
    expect((await refusal(openConsole(t.ctx, req(), sink)))?.status).toBe(401);
    expect((await refusal(openConsole(t.ctx, req({ token: "fr_nope" }), sink)))?.status).toBe(401);
    expect((await refusal(openConsole(t.ctx, req({ token: t.tokens.deployer }), sink)))?.status).toBe(403);
    expect((await refusal(openConsole(t.ctx, req({ token: t.tokens.viewer }), sink)))?.status).toBe(403);
    expect(t.consoles).toHaveLength(0);
  });

  it("takes the dashboard's session cookie, but only from the dashboard's own page", async () => {
    const { t, sink, req } = await setup();
    const ok = await openConsole(t.ctx, req({ cookie: t.tokens.admin, origin: "https://freighter.example.com" }), sink);
    ok.close();
    expect((await refusal(openConsole(t.ctx, req({ cookie: t.tokens.admin, origin: "https://evil.example.net" }), sink)))?.status).toBe(403); // another site cannot borrow the session
    expect((await refusal(openConsole(t.ctx, req({ cookie: t.tokens.admin, origin: "not a url" }), sink)))?.status).toBe(403);
    expect(t.consoles).toHaveLength(1);
  });

  it("checks what it is asked for", async () => {
    const { t, sink, req } = await setup();
    const asAdmin = (query: string) => openConsole(t.ctx, req({ token: t.tokens.admin, query }), sink);
    expect((await refusal(asAdmin("app=shop")))?.status).toBe(400); // no service
    expect((await refusal(asAdmin("app=shop&service=web&cols=0")))?.status).toBe(400);
    expect((await refusal(asAdmin("app=ghost&service=web")))?.status).toBe(404);
    t.registry.apps.ensure("storage-files", "local", "storage");
    expect((await refusal(asAdmin("app=storage-files&service=s3")))?.status).toBe(409);
  });

  it("passes on why the agent would not open one", async () => {
    const { t, sink, req } = await setup();
    t.failConsole(new t.AgentError("conflict", "service web is not running (inactive/dead): there is nothing to open a console in"));
    const e = await refusal(openConsole(t.ctx, req({ token: t.tokens.admin }), sink));
    expect(e).toMatchObject({ status: 409, message: expect.stringMatching(/not running/) });
    expect(t.registry.audit.list().some((a) => a.action === "console.open")).toBe(false); // nothing was opened
  });
});
