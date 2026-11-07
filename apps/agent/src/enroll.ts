import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createCsr, fingerprint } from "@freighter/pki";
import { parse, stringify } from "yaml";

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

const norm = (fp: string) => fp.replace(/^SHA256:/i, "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();

/**
 * Turn this host into a managed server: create a key and CSR locally (the key never leaves the machine), have the
 * control plane sign it, check the CA against the pinned fingerprint, then write the certificates and enable the
 * mutual-TLS listener in the host config.
 */
export async function enroll(o: EnrollOptions): Promise<{ name: string; port: number; caFingerprint: string }> {
  const { csrPem, keyPem } = await createCsr("freighter-agent");
  const res = await (o.fetchImpl ?? fetch)(`${o.control.replace(/\/+$/, "")}/api/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: o.token, csr: csrPem }),
  });
  const json = (await res.json().catch(() => ({}))) as { name?: string; port?: number; serverCert?: string; caCert?: string; error?: { message?: string } };
  if (!res.ok || !json.serverCert || !json.caCert || !json.name) {
    throw new Error(`enrollment failed (${res.status}): ${json.error?.message ?? res.statusText}`);
  }
  const actual = fingerprint(json.caCert);
  if (norm(actual) !== norm(o.caFingerprint)) {
    throw new Error(`the control plane's CA fingerprint (${actual}) does not match the one you pinned; nothing was written`);
  }

  await mkdir(o.certDir, { recursive: true, mode: 0o700 });
  await writeFile(`${o.certDir}/server.key`, keyPem, { mode: 0o600 });
  await chmod(`${o.certDir}/server.key`, 0o600);
  await writeFile(`${o.certDir}/server.crt`, json.serverCert);
  await writeFile(`${o.certDir}/ca.crt`, json.caCert);

  const port = o.port ?? json.port ?? 7443;
  let config: Record<string, any> = {};
  try {
    config = (parse(await readFile(o.configPath, "utf8")) as Record<string, any>) ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  config.agent = { ...config.agent, remote: { ...config.agent?.remote, enabled: true, port } };
  await mkdir(dirname(o.configPath), { recursive: true });
  await writeFile(o.configPath, stringify(config));
  return { name: json.name, port, caFingerprint: actual };
}
