import { readFile, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join, dirname } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import { certCommonName } from "@freighter/pki";
import type { Deps } from "@freighter/core";
import { serveConnection } from "./connection.ts";
import { createHandlers, type Handlers } from "./handlers.ts";

const SPOOL_SUFFIX = ".tar.gz";
const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SOCKET_DIRECTORY_MODE = 0o750;
const ARTIFACTS_DIRECTORY_MODE = 0o770;
const SOCKET_MODE = 0o660;
const REMOTE_MIN_TLS_VERSION = "TLSv1.3";
const CERTIFICATE_FILES = ["server.key", "server.crt", "ca.crt"] as const;

export interface RunningAgent {
  socketPath: string;
  /** Present when the mutual-TLS listener is enabled. */
  remote?: { host: string; port: number };
  close(): Promise<void>;
}

interface RemoteListener {
  server: TlsServer;
  info: NonNullable<RunningAgent["remote"]>;
}

/** Remove spooled artifacts older than a day (leftovers from interrupted uploads). */
async function pruneSpool(directory: string, maxAgeMs = SPOOL_MAX_AGE_MS): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(SPOOL_SUFFIX)) continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > maxAgeMs) await rm(path, { force: true });
  }
}

async function prepareAgentPaths(socketPath: string, artifactsDir: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: SOCKET_DIRECTORY_MODE });
  await mkdir(artifactsDir, { recursive: true, mode: ARTIFACTS_DIRECTORY_MODE });
  await pruneSpool(artifactsDir);
  await rm(socketPath, { force: true }); // stale socket from a previous run
}

function listenOnPath(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

function listenOnPort(server: TlsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function startUnixListener(deps: Deps, handlers: Handlers, socketPath: string): Promise<Server> {
  const server = createServer((socket) => serveConnection(socket, deps, handlers));
  await listenOnPath(server, socketPath);
  await chmod(socketPath, SOCKET_MODE);
  return server;
}

async function grantSocketGroupAccess(deps: Deps, socketPath: string, artifactsDir: string): Promise<void> {
  if (deps.dev) return;
  // Let members of the API's group (and only them) talk to the socket and write artifacts.
  for (const path of [dirname(socketPath), socketPath, artifactsDir]) {
    await deps.run("chgrp", [deps.config.agent.group, path]);
  }
}

function peerCommonName(socket: TLSSocket): string | undefined {
  const certificate = socket.getPeerCertificate();
  if (!certificate.raw) return undefined;
  const pem = `-----BEGIN CERTIFICATE-----\n${certificate.raw.toString("base64")}\n-----END CERTIFICATE-----\n`;
  return certCommonName(pem);
}

function isControlPlane(socket: TLSSocket, expectedCommonName: string): boolean {
  return socket.authorized && peerCommonName(socket) === expectedCommonName;
}

async function startRemoteListener(deps: Deps, handlers: Handlers): Promise<RemoteListener | undefined> {
  const { remote } = deps.config.agent;
  if (!remote.enabled) return undefined;

  const [key, cert, ca] = await Promise.all(
    CERTIFICATE_FILES.map((file) => readFile(join(remote.certDir, file), "utf8")),
  );
  const server = createTlsServer(
    { key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: REMOTE_MIN_TLS_VERSION },
    (socket) => {
      // The handshake proves the client holds a certificate from our CA; only the control plane's identity may operate.
      if (!isControlPlane(socket, remote.clientCn)) {
        socket.destroy();
        return;
      }
      serveConnection(socket, deps, handlers);
    },
  );
  server.on("tlsClientError", () => {});
  await listenOnPort(server, remote.port, remote.listen);

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the remote listener has no TCP address");
  }
  return { server, info: { host: remote.listen, port: address.port } };
}

type ClosableServer = Server & { closeAllConnections?: () => void };

function closeServer(server: ClosableServer | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Start the agent: a unix socket, plus an optional mutual-TLS listener, both speaking the NDJSON protocol. */
export async function startAgent(deps: Deps, options: { socketPath?: string } = {}): Promise<RunningAgent> {
  const socketPath = options.socketPath ?? deps.config.agent.socket;
  const artifactsDir = deps.config.agent.artifactsDir;
  const handlers = createHandlers(deps);

  await prepareAgentPaths(socketPath, artifactsDir);
  const unix = await startUnixListener(deps, handlers, socketPath);
  await grantSocketGroupAccess(deps, socketPath, artifactsDir);
  const remote = await startRemoteListener(deps, handlers);

  return {
    socketPath,
    remote: remote?.info,
    close: async () => {
      await Promise.all([closeServer(unix), closeServer(remote?.server)]);
      await rm(socketPath, { force: true });
    },
  };
}
