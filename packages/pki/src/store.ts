import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createCa, issueClientCert, type KeyPair } from "./certs.ts";

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeSecret(path: string, content: string) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** The control plane's PKI directory: the CA and the client identity used to talk to agents. */
export class PkiStore {
  constructor(readonly dir: string) {}

  private p = (f: string) => `${this.dir}/${f}`;

  /** Create the CA on first use. The CA key stays in this directory (mode 0600). */
  async ensureCa(): Promise<KeyPair> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const [cert, key] = await Promise.all([readIfExists(this.p("ca.crt")), readIfExists(this.p("ca.key"))]);
    if (cert && key) return { certPem: cert, keyPem: key };
    const ca = await createCa();
    await writeSecret(this.p("ca.key"), ca.keyPem);
    await writeFile(this.p("ca.crt"), ca.certPem);
    return ca;
  }

  /** The certificate + key the control plane presents to agents. */
  async ensureControlClient(): Promise<KeyPair> {
    const ca = await this.ensureCa();
    const [cert, key] = await Promise.all([readIfExists(this.p("client.crt")), readIfExists(this.p("client.key"))]);
    if (cert && key) return { certPem: cert, keyPem: key };
    const client = await issueClientCert({ ca });
    await writeSecret(this.p("client.key"), client.keyPem);
    await writeFile(this.p("client.crt"), client.certPem);
    return client;
  }
}
