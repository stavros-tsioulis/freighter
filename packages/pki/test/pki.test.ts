import { mkdtemp, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  CONTROL_CLIENT_CN, PkiStore, certCommonName, certExpiry, createCa, createCsr, fingerprint, issueClientCert, issueServerCert,
} from "../src/index.ts";

/** Start a TLS server that requires a client cert from our CA and echoes the client CN. */
async function startServer(ca: { certPem: string }, server: { certPem: string; keyPem: string }) {
  const srv = createServer({ key: server.keyPem, cert: server.certPem, ca: ca.certPem, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (s) => {
    s.end(`hello ${certCommonName(s.getPeerCertificate(true).raw ? `-----BEGIN CERTIFICATE-----\n${s.getPeerCertificate(true).raw.toString("base64")}\n-----END CERTIFICATE-----\n` : "")}`);
  });
  srv.on("tlsClientError", () => {});
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function request(port: number, o: { ca: string; cert?: string; key?: string; servername?: string }) {
  const s: TLSSocket = connect({ host: "127.0.0.1", port, ca: o.ca, cert: o.cert, key: o.key, servername: o.servername, minVersion: "TLSv1.3" });
  let data = "";
  s.on("data", (d) => (data += d));
  const outcome = await new Promise<"ok" | "closed" | Error>((resolve) => {
    s.once("end", () => resolve("ok"));
    s.once("error", (e) => resolve(e));
    s.once("close", () => resolve("closed"));
  });
  s.destroy();
  return { outcome, data };
}

describe("certificates", () => {
  it("builds a CA, a server cert from a CSR and a client cert", async () => {
    const ca = await createCa();
    const { csrPem, keyPem } = await createCsr("ignored-name");
    const serverCert = await issueServerCert({ ca, csrPem, name: "vps-1", hosts: ["vps1.example.com", "10.0.0.5"] });
    const client = await issueClientCert({ ca });

    expect(certCommonName(serverCert)).toBe("vps-1"); // from our record, not from the CSR
    expect(certCommonName(client.certPem)).toBe(CONTROL_CLIENT_CN);
    expect(fingerprint(ca.certPem)).toMatch(/^SHA256:([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(certExpiry(serverCert).getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    expect(keyPem).toContain("PRIVATE KEY");
    await expect(issueServerCert({ ca, csrPem, name: "x", hosts: [] })).rejects.toThrow(/at least one host/);
    await expect(issueServerCert({ ca, csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----", name: "x", hosts: ["a.example.com"] })).rejects.toThrow();
  });

  it("completes a mutual-TLS handshake and rejects strangers", async () => {
    const ca = await createCa();
    const otherCa = await createCa({ commonName: "Other CA" });
    const { csrPem, keyPem } = await createCsr("agent");
    const serverCert = await issueServerCert({ ca, csrPem, name: "vps-1", hosts: ["127.0.0.1"] });
    const client = await issueClientCert({ ca });
    const stranger = await issueClientCert({ ca: otherCa });
    const srv = await startServer(ca, { certPem: serverCert, keyPem });

    try {
      const good = await request(srv.port, { ca: ca.certPem, cert: client.certPem, key: client.keyPem });
      expect(good).toEqual({ outcome: "ok", data: `hello ${CONTROL_CLIENT_CN}` });

      const noCert = await request(srv.port, { ca: ca.certPem });
      expect(noCert.data).toBe(""); // TLS 1.3 reports the rejection after the handshake; no application data flows
      const wrongCa = await request(srv.port, { ca: ca.certPem, cert: stranger.certPem, key: stranger.keyPem });
      expect(wrongCa.data).toBe("");
      // the client refuses a server whose certificate is not for the name it dialed
      const wrongName = await request(srv.port, { ca: ca.certPem, cert: client.certPem, key: client.keyPem, servername: "evil.example.com" });
      expect(wrongName.outcome).toBeInstanceOf(Error);
      // ...and one signed by a CA it does not trust
      const untrusted = await request(srv.port, { ca: otherCa.certPem, cert: client.certPem, key: client.keyPem });
      expect(untrusted.outcome).toBeInstanceOf(Error);
    } finally {
      await srv.close();
    }
  });
});

describe("PkiStore", () => {
  it("creates the CA and client identity once, with private keys at 0600", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "freighter-pki-")), "pki");
    const store = new PkiStore(dir);
    const a = await store.ensureCa();
    const b = await store.ensureCa();
    expect(b.certPem).toBe(a.certPem);
    const c1 = await store.ensureControlClient();
    const c2 = await store.ensureControlClient();
    expect(c2.certPem).toBe(c1.certPem);
    expect(certCommonName(c1.certPem)).toBe(CONTROL_CLIENT_CN);
    for (const f of ["ca.key", "client.key"]) expect((await stat(join(dir, f))).mode & 0o777).toBe(0o600);
  });
});
