import { z } from "zod";
import { IDENT_RE } from "./schema.ts";

/**
 * S3 storages. A storage is served by `rclone serve s3` from an app that Freighter creates and manages (named
 * `storage-<name>`); its backend is the local disk of the server, or a remote system rclone talks to natively.
 */
export const STORAGE_PREFIX = "storage-";
export const storageApp = (name: string) => `${STORAGE_PREFIX}${name}`;
/** The storage a managed app serves, or null for any other app. */
export const storageOfApp = (app: string): string | null => (app.startsWith(STORAGE_PREFIX) && IDENT_RE.test(app.slice(STORAGE_PREFIX.length)) ? app.slice(STORAGE_PREFIX.length) : null);

const host = z.string().regex(/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/, "expected a host name or IPv4 address");
const port = z.number().int().min(1).max(65535).optional();
const user = z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/, "letters, digits and . _ @ - only");
// A path on the remote system: no control characters, quotes or `..` segments.
const remotePath = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9._/ @+-]*$/, "letters, digits, spaces and . _ / @ + - only")
  .refine((p) => !p.split("/").includes(".."), "no .. segments")
  .default("");

export const storageBackendSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("sftp"),
    host,
    port,
    user,
    path: remotePath,
    /** `password` or a private key; the secret itself is sent separately and stored apart from this. */
    auth: z.enum(["password", "key"]),
    /** The pinned host key, as a `known_hosts` line. Required before the storage can be created. */
    hostKey: z.string().max(2000).regex(/^[A-Za-z0-9.:\[\]=@+/ -]+$/, "not a host key line").optional(),
  }),
  z.object({
    kind: z.literal("smb"),
    host,
    port,
    share: z.string().regex(/^[A-Za-z0-9._ $-]{1,80}$/, "letters, digits, spaces and . _ $ - only"),
    user,
    domain: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
    path: remotePath,
  }),
]);
export type StorageBackend = z.infer<typeof storageBackendSchema>;

export const storageNameSchema = z.string().regex(IDENT_RE).max(40);

/** Secrets that go with a backend. Never stored in `config`; the API seals them and the agent keeps them root-only. */
export const storageSecretsSchema = z.object({
  password: z.string().min(1).max(1000).refine((v) => !/[\r\n\0]/.test(v), "no newlines").optional(),
  privateKey: z.string().min(1).max(20_000).optional(),
});
export type StorageSecrets = z.infer<typeof storageSecretsSchema>;
