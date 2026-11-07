import { X509Certificate, randomBytes, webcrypto } from "node:crypto";
import { isIP } from "node:net";

// Loosely typed on purpose: consumers compile this file with different lib settings (Node vs DOM), whose
// CryptoKey declarations are not assignable to each other.
/* eslint-disable @typescript-eslint/no-explicit-any */
type CryptoKey = any;
type CryptoKeyPair = { publicKey: any; privateKey: any };

type X509 = typeof import("@peculiar/x509");
let lib: Promise<X509> | undefined;
/**
 * @peculiar/x509 needs `reflect-metadata` loaded *before* it (tsyringe checks at import time). Bundlers hoist and
 * reorder static imports, so load both lazily, in order.
 */
const load = (): Promise<X509> =>
  (lib ??= (async () => {
    await import("reflect-metadata");
    const mod = await import("@peculiar/x509");
    mod.cryptoProvider.set(webcrypto as never);
    return mod;
  })());

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const DAY_MS = 86_400_000;

export const CONTROL_CLIENT_CN = "freighter-control-plane";

export interface KeyPair {
  certPem: string;
  keyPem: string;
}

const serial = () => randomBytes(16).toString("hex").replace(/^[89a-f]/, "7"); // positive DER integer

function toPem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function keyToPem(key: CryptoKey): Promise<string> {
  return toPem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", key));
}

async function importSigningKey(pem: string): Promise<CryptoKey> {
  const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
  return webcrypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
}

const newKeys = () => webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

/** A self-signed certificate authority (10 years by default). */
export async function createCa(opts: { commonName?: string; days?: number; now?: Date } = {}): Promise<KeyPair> {
  const x509 = await load();
  const keys = await newKeys();
  const now = opts.now ?? new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=${opts.commonName ?? "Freighter CA"}`,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + (opts.days ?? 3650) * DAY_MS),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await keyToPem(keys.privateKey) };
}

/** Generate a key pair and a certificate signing request; the key never needs to leave the caller. */
export async function createCsr(commonName: string): Promise<{ csrPem: string; keyPem: string }> {
  const x509 = await load();
  const keys = await newKeys();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${commonName}`, keys, signingAlgorithm: ALG });
  return { csrPem: csr.toString("pem"), keyPem: await keyToPem(keys.privateKey) };
}

async function sign(ca: KeyPair, o: { subjectCn: string; publicKey: any; days: number; now?: Date; usage: "server" | "client"; hosts?: string[] }) {
  const x509 = await load();
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await importSigningKey(ca.keyPem);
  const now = o.now ?? new Date();
  const extensions: InstanceType<X509["Extension"]>[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([o.usage === "server" ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth], false),
  ];
  if (o.usage === "server") {
    extensions.push(new x509.SubjectAlternativeNameExtension((o.hosts ?? []).map((h) => ({ type: (isIP(h) ? "ip" : "dns") as "ip" | "dns", value: h }))));
  }
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${o.subjectCn}`,
    issuer: caCert.subject,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + o.days * DAY_MS),
    signingAlgorithm: ALG,
    publicKey: o.publicKey,
    signingKey: caKey,
    extensions,
  });
  return cert.toString("pem");
}

/**
 * Sign a server certificate for a CSR. The subject and SANs come from the *caller* (the registered server record),
 * never from the CSR, so an agent cannot ask for a name it was not assigned.
 */
export async function issueServerCert(o: { ca: KeyPair; csrPem: string; name: string; hosts: string[]; days?: number; now?: Date }): Promise<string> {
  const x509 = await load();
  if (o.hosts.length === 0) throw new Error("at least one host name or IP is required");
  const csr = new x509.Pkcs10CertificateRequest(o.csrPem);
  if (!(await csr.verify())) throw new Error("invalid CSR signature");
  return sign(o.ca, { subjectCn: o.name, publicKey: csr.publicKey, days: o.days ?? 365, now: o.now, usage: "server", hosts: o.hosts });
}

/** Create the control plane's client identity (fresh key, signed by the CA). */
export async function issueClientCert(o: { ca: KeyPair; commonName?: string; days?: number; now?: Date }): Promise<KeyPair> {
  const keys = await newKeys();
  const certPem = await sign(o.ca, { subjectCn: o.commonName ?? CONTROL_CLIENT_CN, publicKey: keys.publicKey, days: o.days ?? 365, now: o.now, usage: "client" });
  return { certPem, keyPem: await keyToPem(keys.privateKey) };
}

/** "SHA256:AA:BB:…" of the (first) certificate in a PEM. */
export const fingerprint = (certPem: string) => `SHA256:${new X509Certificate(certPem).fingerprint256}`;

export const certExpiry = (certPem: string): Date => new X509Certificate(certPem).validToDate;

export const certCommonName = (certPem: string): string | undefined => /CN=([^\n,]+)/.exec(new X509Certificate(certPem).subject)?.[1];

/** Throws unless `csrPem` is a well-formed PKCS#10 request with a valid signature. */
export async function assertValidCsr(csrPem: string): Promise<void> {
  const x509 = await load();
  let ok = false;
  try {
    ok = await new x509.Pkcs10CertificateRequest(csrPem).verify();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("invalid certificate signing request");
}
