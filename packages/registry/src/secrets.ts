import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Authenticated encryption (AES-256-GCM) for credentials stored in the registry. */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

function box(key: Buffer): SecretBox {
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
    },
    open(sealed) {
      const [v, iv, tag, ct] = sealed.split(".");
      if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognised secret format");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
    },
  };
}

/** A box keyed by a 32-byte file (created with mode 0600 on first use) that lives next to the database. */
export function createSecretBox(keyPath: string): SecretBox {
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error(`${keyPath} must contain exactly 32 bytes`);
  return box(key);
}

/** A throw-away box for tests and in-memory registries. */
export const memorySecretBox = (): SecretBox => box(randomBytes(32));
