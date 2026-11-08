import { X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Run } from "@freighter/systemd";

export interface AcmeConfig {
  email?: string;
  staging: boolean;
  challengePort: number;
  letsencryptDir: string;
  renewBeforeDays: number;
  /** How certbot proves control of a hostname (default `http`). */
  challenge?: "http" | "cloudflare-dns";
  /** certbot's Cloudflare credentials file, for `cloudflare-dns`. */
  cloudflareCredentials?: string;
  dnsPropagationSeconds?: number;
}

const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
export const certPath = (dir: string, hostname: string) => `${dir}/certs/${hostname}.pem`;

/** Expiry of the first certificate in a PEM file, or null if the file is missing/unreadable. */
export async function certExpiry(path: string): Promise<Date | null> {
  try {
    return new X509Certificate(await readFile(path)).validToDate;
  } catch {
    return null;
  }
}

export interface EnsureCertOptions {
  hostname: string;
  dir: string;
  acme: AcmeConfig;
  run: Run;
  now?: () => Date;
  /** Re-issue even if the current certificate is still valid. */
  force?: boolean;
}

/** Make sure `<dir>/certs/<hostname>.pem` exists and is valid for at least `renewBeforeDays`. */
export async function ensureCert(o: EnsureCertOptions): Promise<{ issued: boolean; expires: Date | null }> {
  if (!HOST_RE.test(o.hostname)) throw new Error(`invalid hostname "${o.hostname}"`);
  const now = (o.now ?? (() => new Date()))();
  const pem = certPath(o.dir, o.hostname);
  const existing = await certExpiry(pem);
  if (!o.force && existing && existing.getTime() - now.getTime() > o.acme.renewBeforeDays * 86_400_000) {
    return { issued: false, expires: existing };
  }
  if (!o.acme.email) throw new Error("acme.email is not set in /etc/freighter/config.yaml (required for tls: auto)");

  const dns = o.acme.challenge === "cloudflare-dns";
  if (dns) {
    const file = o.acme.cloudflareCredentials ?? "/etc/freighter/cloudflare.ini";
    if (!(await readFile(file, "utf8").then((t) => /dns_cloudflare_api_token\s*=\s*\S/.test(t), () => false))) {
      throw new Error(`acme.challenge is cloudflare-dns, but ${file} has no "dns_cloudflare_api_token = ..." line (a token with Zone:DNS:Edit, file mode 600)`);
    }
  }
  const challenge = dns
    ? ["--dns-cloudflare", "--dns-cloudflare-credentials", o.acme.cloudflareCredentials ?? "/etc/freighter/cloudflare.ini", "--dns-cloudflare-propagation-seconds", String(o.acme.dnsPropagationSeconds ?? 30)]
    : ["--standalone", "--preferred-challenges", "http", "--http-01-port", String(o.acme.challengePort)];
  const args = [
    "certonly", ...challenge,
    "--non-interactive", "--agree-tos", "--keep-until-expiring", "-m", o.acme.email,
    "--cert-name", o.hostname, "-d", o.hostname,
    ...(o.acme.staging ? ["--test-cert"] : []),
  ];
  const r = await o.run("certbot", args);
  if (r.code !== 0) {
    throw new Error(
      `certbot failed for ${o.hostname} (exit ${r.code}): ${(r.stderr ?? r.stdout).trim().split("\n").slice(-3).join(" | ")}\n` +
        (dns
          ? "check that the Cloudflare token can edit this hostname's zone, and that certbot-dns-cloudflare is installed, or set `tls: off` for the domain"
          : "check that DNS points at this server and port 80 reaches HAProxy (or set acme.challenge to cloudflare-dns), or set `tls: off` for the domain"),
    );
  }
  const live = `${o.acme.letsencryptDir}/live/${o.hostname}`;
  const [chain, key] = await Promise.all([readFile(`${live}/fullchain.pem`, "utf8"), readFile(`${live}/privkey.pem`, "utf8")]);
  await mkdir(`${o.dir}/certs`, { recursive: true });
  const tmp = `${pem}.tmp`;
  await writeFile(tmp, `${chain.trimEnd()}\n${key.trimEnd()}\n`, { mode: 0o600 });
  await rename(tmp, pem);
  return { issued: true, expires: await certExpiry(pem) };
}
