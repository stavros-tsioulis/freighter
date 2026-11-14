import { afterEach, describe, expect, it } from "vitest";
import { FRAME, createAgentClient, parseExit, type AgentClient } from "@freighter/protocol";
import { artifact, makeDeps } from "@freighter/core/testing";
import { deploy, setEnv } from "@freighter/core";
import { startAgent, type RunningAgent } from "../src/index.ts";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

const MANIFEST = "name: shop\nservices:\n  web:\n    command: node web.mjs\n    secrets: [TOKEN]\n    environment:\n      MODE: prod\n";

async function setup(console?: { enabled?: boolean; maxSessions?: number }) {
  const h = await makeDeps();
  h.deps.config.agent.artifactsDir = `${h.root}/spool`;
  if (console) h.deps.config.agent.console = { enabled: console.enabled ?? true, idleMinutes: 30, maxSessions: console.maxSessions ?? 8 };
  h.deps.dev = true; // no user switch: the shell runs as whoever runs the tests
  await setEnv(h.deps, "shop", "web", "TOKEN", "s3cret");
  await deploy(h.deps, { manifestText: MANIFEST, source: await artifact() });
  agent = await startAgent(h.deps, { socketPath: `${h.root}/run/agent.sock` });
  const client: AgentClient = createAgentClient(agent.socketPath, { timeoutMs: 10_000 });
  return { ...h, client };
}

describe("console over the agent protocol", () => {
  it("opens a shell in the service, with its environment, and reports how it ended", async () => {
    const { client } = await setup();
    const session = await client.openConsole({ app: "shop", service: "web", cols: 90, rows: 25 });
    expect(session.result).toMatchObject({ kind: "host", user: "shop" });
    let output = "";
    const exited = new Promise<number>((resolve) =>
      session.onFrame((f) => {
        if (f.type === FRAME.data) output += f.payload.toString();
        if (f.type === FRAME.exit) resolve(parseExit(f.payload));
      }),
    );
    session.write('echo "mode=$MODE token=$TOKEN"; stty size; exit 5\n');
    expect(await exited).toBe(5);
    expect(output).toContain("mode=prod token=s3cret");
    expect(output).toContain("25 90");
  });

  it("runs a command without a terminal: output and error apart, input until its end, the exit code", async () => {
    const { client } = await setup();
    const run = (command: string[], o: { env?: Record<string, string>; input?: string } = {}) =>
      new Promise<{ out: string; err: string; code: number }>(async (resolve) => {
        const session = await client.openConsole({ app: "shop", service: "web", command, tty: false, ...(o.env ? { env: o.env } : {}) });
        let out = "";
        let err = "";
        session.onFrame((f) => {
          if (f.type === FRAME.data) out += f.payload.toString();
          if (f.type === FRAME.stderr) err += f.payload.toString();
          if (f.type === FRAME.exit) resolve({ out, err, code: parseExit(f.payload) });
        });
        if (o.input !== undefined) session.write(o.input);
        session.end();
      });

    const a = await run(["/bin/sh", "-c", 'echo "mode=$MODE token=$TOKEN"; echo oops >&2; exit 3']);
    expect(a).toEqual({ out: "mode=prod token=s3cret\n", err: "oops\n", code: 3 });
    const b = await run(["/bin/sh", "-c", "tr a-z A-Z"], { input: "hello\n" }); // reads until the input ends
    expect(b).toMatchObject({ out: "HELLO\n", code: 0 });
    const c = await run(["/bin/sh", "-c", 'echo "$GREETING"'], { env: { GREETING: "hi there" } });
    expect(c.out).toBe("hi there\n");
    const d = await run(["/no/such/command"]);
    expect(d.code).toBe(127);
    expect(d.err).toMatch(/cannot start/);
    const e = await run(["/bin/sh", "-c", "test -t 1 && echo tty || echo plain"]);
    expect(e.out).toBe("plain\n"); // no terminal
  });

  it("refuses an unknown service and a console that is turned off", async () => {
    const { client } = await setup();
    await expect(client.openConsole({ app: "shop", service: "nope" })).rejects.toThrow(/unknown service/);
    await agent?.close();
    const off = await setup({ enabled: false });
    await expect(off.client.openConsole({ app: "shop", service: "web" })).rejects.toThrow(/turned off/);
  });

  it("limits how many are open at once, and frees the place when one closes", async () => {
    const { client } = await setup({ maxSessions: 1 });
    const first = await client.openConsole({ app: "shop", service: "web" });
    await expect(client.openConsole({ app: "shop", service: "web" })).rejects.toThrow(/already open/);
    const closed = new Promise<void>((r) => first.onClose(r));
    first.write("exit\n");
    await closed;
    await new Promise((r) => setTimeout(r, 200));
    const again = await client.openConsole({ app: "shop", service: "web" });
    expect(again.result.kind).toBe("host");
    again.close();
  });

  it("ends the shell when the client goes away", async () => {
    const { client } = await setup();
    const session = await client.openConsole({ app: "shop", service: "web" });
    session.close(); // what a closed browser tab does
    await new Promise((r) => setTimeout(r, 500));
    const next = await client.openConsole({ app: "shop", service: "web" });
    next.close();
  });
});
