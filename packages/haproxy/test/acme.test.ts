import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@freighter/systemd";
import { beforeAll, describe, expect, it } from "vitest";
import { certExpiry, certPath, ensureCert, type AcmeConfig } from "../src/index.ts";

let haveOpenssl = true;
let sample: { cert: string; key: string };

beforeAll(async () => {
  try {
    const d = await mkdtemp(join(tmpdir(), "freighter-ssl-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${d}/k.pem`, "-out", `${d}/c.pem`, "-days", "90", "-subj", "/CN=a.example.com"], { stdio: "ignore" });
    sample = { cert: await readFile(`${d}/c.pem`, "utf8"), key: await readFile(`${d}/k.pem`, "utf8") };
  } catch {
    haveOpenssl = false;
  }
});

const acme = (over: Partial<AcmeConfig> = {}): AcmeConfig => ({
  email: "me@example.com", staging: false, challengePort: 8888, letsencryptDir: "", renewBeforeDays: 30, ...over,
});

async function host(code = 0) {
  const root = await mkdtemp(join(tmpdir(), "freighter-acme-"));
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (code === 0) {
      const live = `${root}/le/live/a.example.com`;
      await mkdir(live, { recursive: true });
      await writeFile(`${live}/fullchain.pem`, sample.cert);
      await writeFile(`${live}/privkey.pem`, sample.key);
    }
    return { stdout: "", stderr: "Challenge failed", code };
  };
  return { root, calls, run, dir: `${root}/hap` };
}

describe("ensureCert", () => {
  it("issues a missing cert with certbot and writes a combined 0600 PEM", async (ctx) => {
    if (!haveOpenssl) return ctx.skip();
    const h = await host();
    const r = await ensureCert({ hostname: "a.example.com", dir: h.dir, acme: acme({ letsencryptDir: `${h.root}/le`, staging: true }), run: h.run });
    expect(r.issued).toBe(true);
    expect(h.calls[0]).toEqual([
      "certbot", "certonly", "--standalone", "--preferred-challenges", "http", "--http-01-port", "8888",
      "--non-interactive", "--agree-tos", "--keep-until-expiring", "-m", "me@example.com",
      "--cert-name", "a.example.com", "-d", "a.example.com", "--test-cert",
    ]);
    const pem = certPath(h.dir, "a.example.com");
    expect((await stat(pem)).mode & 0o777).toBe(0o600);
    expect(await readFile(pem, "utf8")).toContain("PRIVATE KEY");
    expect((await certExpiry(pem))!.getTime()).toBeGreaterThan(Date.now());
  });

  it("skips a cert that is valid long enough, and renews one that is about to expire", async (ctx) => {
    if (!haveOpenssl) return ctx.skip();
    const h = await host();
    const a = acme({ letsencryptDir: `${h.root}/le` });
    await ensureCert({ hostname: "a.example.com", dir: h.dir, acme: a, run: h.run });
    h.calls.length = 0;
    expect((await ensureCert({ hostname: "a.example.com", dir: h.dir, acme: a, run: h.run })).issued).toBe(false);
    expect(h.calls).toEqual([]);
    const soon = () => new Date(Date.now() + 70 * 86_400_000); // cert has ~90 days; 20 left < 30
    expect((await ensureCert({ hostname: "a.example.com", dir: h.dir, acme: a, run: h.run, now: soon })).issued).toBe(true);
    expect((await ensureCert({ hostname: "a.example.com", dir: h.dir, acme: a, run: h.run, force: true })).issued).toBe(true);
  });

  it("requires an email, validates hostnames and explains certbot failures", async () => {
    const h = await host(1);
    await expect(ensureCert({ hostname: "a.example.com", dir: h.dir, acme: acme({ email: undefined }), run: h.run })).rejects.toThrow(/acme\.email/);
    await expect(ensureCert({ hostname: "../x", dir: h.dir, acme: acme(), run: h.run })).rejects.toThrow(/invalid hostname/);
    await expect(ensureCert({ hostname: "a.example.com", dir: h.dir, acme: acme(), run: h.run })).rejects.toThrow(/certbot failed.*Challenge failed.*tls: off/s);
  });
});
