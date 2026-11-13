import { z } from "zod";
import { domainSchema, IDENT_RE } from "./schema.ts";

/** What a connection can read about an app. Ports are the ones in force for the release being resolved. */
export const appFactsSchema = z.object({
  name: z.string().regex(IDENT_RE),
  /** The server it runs on; `internal` only works between apps on the same one. */
  server: z.string().optional(),
  services: z.array(z.string().regex(IDENT_RE)),
  /** The services that run as containers: from inside one, the server is 10.0.2.2, not `127.0.0.1`. */
  containers: z.array(z.string().regex(IDENT_RE)).optional(),
  domains: z.array(domainSchema),
  ports: z.record(z.string(), z.number().int().positive().optional()),
  /** Where each service sees each volume (`@volume:name.path`), per service. */
  volumePaths: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Each service's plain environment values as written (they may contain references themselves). */
  environment: z.record(z.string().regex(IDENT_RE), z.record(z.string(), z.string())),
});
export type AppFacts = z.infer<typeof appFactsSchema>;

/** What a reference to a storage (`@storage:name.url`) can read. The key pair is a credential. */
export const storageFactsSchema = z.object({
  name: z.string().regex(IDENT_RE),
  server: z.string().optional(),
  /** The storage's domain, if it has one. */
  hostname: z.string().optional(),
  tls: z.enum(["auto", "off"]).default("auto"),
  /** The domain of its public, read-only endpoint, if the storage is public and that has one. */
  publicHostname: z.string().optional(),
  publicTls: z.enum(["auto", "off"]).optional(),
  /** The port it listens on, for `internal` (and for `url` while it has no domain). */
  port: z.number().int().positive().optional(),
  accessKey: z.string(),
  secretKey: z.string(),
});
export type StorageFacts = z.infer<typeof storageFactsSchema>;

/** What a deploy knows about the apps around it; the control plane fills this in from the app's project. */
export const connectionsSchema = z.object({
  /** The server this app runs on. */
  server: z.string().optional(),
  /** The other apps in the same project, which environment values may connect to (`@app/service.url`). */
  peers: z.record(z.string().regex(IDENT_RE), appFactsSchema).default({}),
  /** The storages this app's environment uses (only those; they carry credentials). */
  storages: z.record(z.string().regex(IDENT_RE), storageFactsSchema).optional(),
});
export type Connections = z.infer<typeof connectionsSchema>;
