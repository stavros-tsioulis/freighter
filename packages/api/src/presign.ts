import { createHash, createHmac } from "node:crypto";

/** AWS's URI encoding: everything but unreserved characters, byte by byte (`/` kept only between path segments). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const hex = (data: string) => createHash("sha256").update(data).digest("hex");

export const MAX_LINK_SECONDS = 7 * 24 * 3600;

/**
 * A link that downloads one object without any credentials for as long as `expires` says: the request is signed in its
 * query string (AWS Signature Version 4, "presigned URL"), path-style as the storage serves it. The signature covers the
 * host, so the link only works at the address it was made for.
 */
export function presignGet(o: { endpoint: string; path: string; accessKey: string; secretKey: string; expires: number; now?: Date; region?: string }): string {
  const url = new URL(o.endpoint);
  const region = o.region ?? "us-east-1";
  const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20130524T000000Z
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const path = o.path.split("/").map(enc).join("/");
  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${o.accessKey}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(o.expires)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query.map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join("&");
  const canonical = ["GET", path, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `${url.protocol}//${url.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
