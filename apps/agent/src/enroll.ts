import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCsr, fingerprint } from "@freighter/pki";
import { parse, stringify } from "yaml";

const DEFAULT_AGENT_PORT = 7443;
const CERT_DIRECTORY_MODE = 0o700;
const KEY_FILE_MODE = 0o600;

export interface EnrollOptions {
  /** Base URL of the control plane, e.g. https://freighter.example.com */
  control: string;
  token: string;
  /** CA fingerprint shown when the server was added (verified before anything is written). */
  caFingerprint: string;
  certDir: string;
  configPath: string;
  /** Overrides the port suggested by the control plane. */
  port?: number;
  fetchImpl?: typeof fetch;
}

interface EnrollmentResponse {
  name?: string;
  port?: number;
  serverCert?: string;
  caCert?: string;
  error?: { message?: string };
}

interface SignedCertificates {
  name: string;
  serverCert: string;
  caCert: string;
  port?: number;
}

interface CertificateFiles {
  certDir: string;
  keyPem: string;
  serverCert: string;
  caCert: string;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/^SHA256:/i, "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestCertificates(options: EnrollOptions, csrPem: string): Promise<SignedCertificates> {
  const control = options.control.replace(/\/+$/, "");
  const response = await (options.fetchImpl ?? fetch)(`${control}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: options.token, csr: csrPem }),
  });
  const body = (await response.json().catch(() => ({}))) as EnrollmentResponse;
  if (!response.ok || !body.serverCert || !body.caCert || !body.name) {
    throw new Error(`enrollment failed (${response.status}): ${body.error?.message ?? response.statusText}`);
  }
  return { name: body.name, serverCert: body.serverCert, caCert: body.caCert, port: body.port };
}

async function writeCertificates(files: CertificateFiles): Promise<void> {
  await mkdir(files.certDir, { recursive: true, mode: CERT_DIRECTORY_MODE });
  const keyPath = join(files.certDir, "server.key");
  await writeFile(keyPath, files.keyPem, { mode: KEY_FILE_MODE });
  await chmod(keyPath, KEY_FILE_MODE);
  await writeFile(join(files.certDir, "server.crt"), files.serverCert);
  await writeFile(join(files.certDir, "ca.crt"), files.caCert);
}

async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  try {
    const config = parse(await readFile(path, "utf8"));
    return isRecord(config) ? config : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

function enableRemoteListener(config: Record<string, unknown>, port: number): Record<string, unknown> {
  const agent = isRecord(config.agent) ? config.agent : {};
  const remote = isRecord(agent.remote) ? agent.remote : {};
  return { ...config, agent: { ...agent, remote: { ...remote, enabled: true, port } } };
}

/**
 * Turn this host into a managed server: create a key and CSR locally (the key never leaves the machine), have the
 * control plane sign it, check the CA against the pinned fingerprint, then write the certificates and enable the
 * mutual-TLS listener in the host config.
 */
export async function enroll(options: EnrollOptions): Promise<{ name: string; port: number; caFingerprint: string }> {
  const { csrPem, keyPem } = await createCsr("freighter-agent");
  const signed = await requestCertificates(options, csrPem);

  const caFingerprint = fingerprint(signed.caCert);
  if (normalizeFingerprint(caFingerprint) !== normalizeFingerprint(options.caFingerprint)) {
    throw new Error(`the control plane's CA fingerprint (${caFingerprint}) does not match the one you pinned; nothing was written`);
  }

  await writeCertificates({
    certDir: options.certDir,
    keyPem,
    serverCert: signed.serverCert,
    caCert: signed.caCert,
  });

  const port = options.port ?? signed.port ?? DEFAULT_AGENT_PORT;
  const config = await readConfigFile(options.configPath);
  await mkdir(dirname(options.configPath), { recursive: true });
  await writeFile(options.configPath, stringify(enableRemoteListener(config, port)));
  return { name: signed.name, port, caFingerprint };
}
