import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgentClient } from "@freighter/protocol";
import { artifact, makeDeps } from "@freighter/core/testing";
import { deploy, setEnv } from "@freighter/core";
import { startAgent } from "@freighter/agent";
import { createApi, createConsoleBridge, type WirePeer } from "@freighter/api";
import { PkiStore } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, toNodeListener, useBase } from "h3";
import { WebSocketServer } from "ws";

const MANIFEST = "name: shop\nservices:\n  web:\n    command: node web.mjs\n    secrets: [TOKEN]\n    environment:\n      MODE: prod\n";

/**
 * The whole chain for the console, for real except the machine: a real agent on a socket (a shell run as whoever runs the
 * tests), the real API with its console bridge on a WebSocket, a deployed app with environment and a secret.
 */
export async function startConsoleServer() {
  const h = await makeDeps();
  h.deps.config.agent.artifactsDir = `${h.root}/spool`;
  h.deps.dev = true;
  await setEnv(h.deps, "shop", "web", "TOKEN", "s3cret");
  await deploy(h.deps, { manifestText: MANIFEST, source: await artifact() });
  const agent = await startAgent(h.deps, { socketPath: `${h.root}/run/agent.sock` });
  const client = createAgentClient(agent.socketPath, { timeoutMs: 10_000 });

  const registry = openRegistry(":memory:");
  registry.apps.upsert({ name: "shop", server: "local", manifestText: MANIFEST, currentRelease: "r1", previousRelease: null, status: "deployed" });
  const ctx = { registry, agents: { forServer: () => client }, pki: new PkiStore(mkdtempSync(join(tmpdir(), "freighter-pki-"))), artifactsDir: `${h.root}/spool`, maxUploadBytes: 1_000_000, trustProxy: false };
  const api = createApi(ctx as never);
  const bridge = createConsoleBridge(ctx as never);
  const outer = createApp();
  outer.use(useBase("/api", api.app.handler));
  const server = createServer(toNodeListener(outer));
  const wss = new WebSocketServer({ noServer: true });
  let n = 0;
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/_console")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = { get: (name: string) => (req.headers[name.toLowerCase()] as string | undefined) ?? null };
      const peer: WirePeer = { id: `p${++n}`, request: { url: req.url!, headers }, send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) };
      ws.on("message", (data) => bridge.message(peer, new Uint8Array(data as Buffer)));
      ws.on("close", () => bridge.close(peer));
      void bridge.open(peer);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = registry.tokens.create({ name: "admin", role: "admin" }).token;
  return {
    url,
    registry,
    env: { FREIGHTER_URL: url, FREIGHTER_TOKEN: admin },
    token: (role: "viewer" | "deployer" | "admin") => registry.tokens.create({ name: role, role }).token,
    close: async () => {
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => server.close(() => r()));
      await agent.close();
    },
  };
}
