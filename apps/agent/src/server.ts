import { readFile, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { dirname } from "node:path";
import { certCommonName } from "@freighter/pki";
import type { Deps } from "@freighter/core";
import { serveConnection } from "./connection.ts";
import { createHandlers } from "./handlers.ts";

export interface RunningAgent {
  socketPath: string;
  /** Present when the mutual-TLS listener is enabled. */
  remote?: { host: string; port: number };
  close(): Promise<void>;
}

/** Remove spooled artifacts older than a day (leftovers from interrupted uploads). */
async function pruneSpool(dir: string, maxAgeMs = 24 * 3_600_000) {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".tar.gz")) continue;
    const info = await stat(`${dir}/${name}`).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs) await rm(`${dir}/${name}`, { force: true });
  }
}

/** Start the agent: a unix socket, plus an optional mutual-TLS listener, both speaking the NDJSON protocol. */
export async function startAgent(d: Deps, opts: { socketPath?: string } = {}): Promise<RunningAgent> {
  const socketPath = opts.socketPath ?? d.config.agent.socket;
  const handlers = createHandlers(d);
  const { group, artifactsDir, remote } = d.config.agent;

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  await mkdir(artifactsDir, { recursive: true, mode: 0o770 });
  await pruneSpool(artifactsDir);
  await rm(socketPath, { force: true }); // stale socket from a previous run

  const unix = createServer((socket) => serveConnection(socket, d, handlers));
  await new Promise<void>((resolve, reject) => {
    unix.once("error", reject);
    unix.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  if (!d.dev) {
    // Let members of the API's group (and only them) talk to the socket and write artifacts.
    for (const path of [dirname(socketPath), socketPath, artifactsDir]) await d.run("chgrp", [group, path]);
  }

  let tls: ReturnType<typeof createTlsServer> | undefined;
  let remoteInfo: RunningAgent["remote"];
  if (remote.enabled) {
    const [key, cert, ca] = await Promise.all(["server.key", "server.crt", "ca.crt"].map((f) => readFile(`${remote.certDir}/${f}`, "utf8")));
    tls = createTlsServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (socket) => {
      // The handshake proves the client holds a certificate from our CA; only the control plane's identity may operate.
      const peer = socket.getPeerCertificate();
      const cn = peer?.raw ? certCommonName(`-----BEGIN CERTIFICATE-----\n${peer.raw.toString("base64")}\n-----END CERTIFICATE-----\n`) : undefined;
      if (!socket.authorized || cn !== remote.clientCn) return void socket.destroy();
      serveConnection(socket, d, handlers);
    });
    tls.on("tlsClientError", () => {});
    await new Promise<void>((resolve, reject) => {
      tls!.once("error", reject);
      tls!.listen(remote.port, remote.listen, resolve);
    });
    remoteInfo = { host: remote.listen, port: (tls.address() as { port: number }).port };
  }

  return {
    socketPath,
    remote: remoteInfo,
    close: async () => {
      const closeAll = (s: { close(cb: () => void): unknown; closeAllConnections?: () => void } | undefined) =>
        s ? new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); }) : Promise.resolve();
      await Promise.all([closeAll(unix as never), closeAll(tls as never)]);
      await rm(socketPath, { force: true });
    },
  };
}
