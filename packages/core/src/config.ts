import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const hostConfigSchema = z.object({
  haproxy: z
    .object({
      dir: z.string().default("/etc/haproxy/freighter"),
      mainConfig: z.string().default("/etc/haproxy/haproxy.cfg"),
      bin: z.string().default("haproxy"),
      reloadCommand: z.array(z.string()).min(1).default(["systemctl", "reload", "haproxy"]),
      /** Ports HAProxy listens on. Used by `freighter haproxy setup|config`; your own haproxy.cfg has the final say. */
      httpPort: z.number().int().min(1).max(65535).default(80),
      httpsPort: z.number().int().min(1).max(65535).default(443),
      /** HTTPS port clients are redirected to. Defaults to httpsPort; set 443 when your own proxy maps 443 to httpsPort. */
      publicHttpsPort: z.number().int().min(1).max(65535).optional(),
      /** Expect the PROXY protocol on both listeners. */
      acceptProxy: z.boolean().default(false),
    })
    .default({}),
  acme: z
    .object({
      email: z.string().email().optional(),
      staging: z.boolean().default(false),
      challengePort: z.number().int().positive().default(8888),
      letsencryptDir: z.string().default("/etc/letsencrypt"),
      renewBeforeDays: z.number().positive().default(30),
    })
    .default({}),
  ports: z
    .object({ min: z.number().int().positive().default(20000), max: z.number().int().positive().default(29999) })
    .default({})
    .refine((p) => p.min <= p.max, "ports.min must be <= ports.max"),
  drainSeconds: z.number().nonnegative().default(5),
  agent: z
    .object({
      socket: z.string().default("/run/freighter/agent.sock"),
      group: z.string().default("freighter"),
      artifactsDir: z.string().default("/var/lib/freighter/artifacts"),
      maxArtifactMb: z.number().positive().default(200),
      /** Optional mutual-TLS listener so a control plane on another host can manage this one. */
      remote: z
        .object({
          enabled: z.boolean().default(false),
          listen: z.string().default("0.0.0.0"),
          port: z.number().int().min(0).max(65535).default(7443),
          certDir: z.string().default("/etc/freighter/agent"),
          /** Only a client certificate with this common name may talk to the agent. */
          clientCn: z.string().default("freighter-control-plane"),
        })
        .default({}),
    })
    .default({}),
  git: z
    .object({
      /** Accept local paths / file:// repositories (tests and the lab only). */
      allowLocal: z.boolean().default(false),
      /** ssh StrictHostKeyChecking mode for first contact with a git host. */
      knownHosts: z.enum(["accept-new", "yes"]).default("accept-new"),
      buildUser: z.string().default("freighter-build"),
      buildDir: z.string().default("/var/lib/freighter-build"),
      keyDir: z.string().default("/var/lib/freighter/git"),
    })
    .default({}),
  pki: z.object({ dir: z.string().default("/var/lib/freighter/pki") }).default({}),
  registry: z.object({ path: z.string().default("/var/lib/freighter/registry.db") }).default({}),
  api: z
    .object({
      maxUploadMb: z.number().positive().default(200),
      syncSeconds: z.number().nonnegative().default(60),
      /** How often the API samples service metrics (0 disables) and how long samples are kept. */
      metricsSeconds: z.number().nonnegative().default(15),
      metricsRetentionHours: z.number().positive().default(6),
      /** Public base URL of this control plane (webhook URLs are built from it). Derived from requests when unset. */
      publicUrl: z.string().url().optional(),
      /**
       * DNS servers used to verify domains. Public resolvers by default, so a stale cache on the local network
       * doesn't hide a correct change; set [] to use the system's resolver (e.g. for split-horizon DNS).
       */
      dnsServers: z.array(z.string().ip()).default(["1.1.1.1", "8.8.8.8"]),
      /** Public IP address(es) of this host, shown as the DNS target when adding domains to apps on the local server. */
      publicIps: z.array(z.string().ip()).default([]),
      /**
       * Whether this control server also runs apps, through the agent on the same machine (the server named "local").
       * Off by default: a control plane manages remote servers and runs no agent of its own.
       */
      localAgent: z.boolean().default(false),
      /** Trust X-Forwarded-For (the API normally sits behind HAProxy on localhost). */
      trustProxy: z.boolean().default(true),
    })
    .default({}),
});

export type HostConfig = z.infer<typeof hostConfigSchema>;

export const parseHostConfig = (raw: unknown = {}): HostConfig => hostConfigSchema.parse(raw ?? {});

export const HOST_CONFIG_PATH = "/etc/freighter/config.yaml";

export async function loadHostConfig(path = HOST_CONFIG_PATH): Promise<HostConfig> {
  try {
    return parseHostConfig(parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return parseHostConfig({});
    throw e;
  }
}

/** Relocate every filesystem path in the config under `prefix` (dev/test mode). */
export function applyPrefix(config: HostConfig, prefix: string): HostConfig {
  config.haproxy.dir = prefix + config.haproxy.dir;
  config.haproxy.mainConfig = prefix + config.haproxy.mainConfig;
  config.acme.letsencryptDir = prefix + config.acme.letsencryptDir;
  config.agent.socket = prefix + config.agent.socket;
  config.agent.artifactsDir = prefix + config.agent.artifactsDir;
  config.registry.path = prefix + config.registry.path;
  config.agent.remote.certDir = prefix + config.agent.remote.certDir;
  config.pki.dir = prefix + config.pki.dir;
  config.git.buildDir = prefix + config.git.buildDir;
  config.git.keyDir = prefix + config.git.keyDir;
  return config;
}

/** Load /etc/freighter/config.yaml (or its copy under `prefix`), with paths relocated when a prefix is given. */
export async function loadConfig(prefix?: string): Promise<HostConfig> {
  if (!prefix) return loadHostConfig();
  const abs = resolve(prefix);
  return applyPrefix(await loadHostConfig(abs + HOST_CONFIG_PATH), abs);
}
