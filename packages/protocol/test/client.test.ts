import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, LineReader, createAgentClient, readLines } from "../src/index.ts";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function serve(handler: (req: { id: string; op: string; args: unknown }) => unknown | undefined) {
  const path = join(await mkdtemp(join(tmpdir(), "freighter-sock-")), "a.sock");
  server = createServer((sock) => {
    readLines(sock, (line) => {
      const req = JSON.parse(line);
      const reply = handler(req);
      if (reply !== undefined) sock.write(JSON.stringify({ id: req.id, ...(reply as object) }) + "\n");
    }, () => sock.destroy());
  });
  await new Promise<void>((r) => server!.listen(path, r));
  return path;
}

describe("agent client", () => {
  it("round-trips a validated result", async () => {
    const path = await serve((req) => ({ ok: true, result: { version: "1", time: req.op } }));
    expect(await createAgentClient(path).call("ping", {})).toEqual({ version: "1", time: "ping" });
  });
  it("maps wire errors, including extras", async () => {
    const path = await serve(() => ({ ok: false, error: { code: "deploy_failed", message: "boom", rolledBackTo: "r1", historyAt: "t" } }));
    const err = await createAgentClient(path).call("apps.list", {}).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: "deploy_failed", message: "boom", extra: { rolledBackTo: "r1", historyAt: "t" } });
  });
  it("rejects replies that do not match the schema", async () => {
    const path = await serve(() => ({ ok: true, result: { nope: 1 } }));
    await expect(createAgentClient(path).call("ping", {})).rejects.toThrow(/did not match the protocol/);
  });
  it("reports an unavailable agent and times out silent ones", async () => {
    await expect(createAgentClient("/nonexistent/agent.sock").call("ping", {})).rejects.toMatchObject({ code: "unavailable" });
    const path = await serve(() => undefined);
    await expect(createAgentClient(path).call("ping", {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});
