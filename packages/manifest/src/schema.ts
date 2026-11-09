import { z } from "zod";
import { SHARED_VOLUME, findReferences, isEnvAttr } from "./reference.ts";

/** Lowercase identifier: segments of [a-z0-9] joined by single hyphens, starting with a letter. */
export const IDENT_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

const ident = z.string().regex(IDENT_RE, "expected lowercase letters, digits and single hyphens");
const envKey = z.string().regex(ENV_KEY_RE, "expected UPPER_SNAKE_CASE");
const duration = z.string().regex(/^\d+(ms|s|m|h)$/, "expected e.g. 10s");

/**
 * A container image reference such as `nginx`, `ghcr.io/org/app:1.2` or `ghcr.io/org/app@sha256:<64 hex>`.
 * Deliberately strict: it ends up in a unit file, so no whitespace, quotes or shell characters are allowed.
 */
export const IMAGE_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

/** Where on the machine a command service may see a volume: not over system directories. */
export const FORBIDDEN_TARGETS = ["/proc", "/sys", "/dev", "/etc", "/run", "/boot", "/usr", "/bin", "/sbin", "/lib", "/root", "/home", "/srv/apps", "/var/lib/freighter"];

const hostName = z.string().min(1).max(253).regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "expected a host name or address");
const safePath = z.string().max(300).regex(/^[A-Za-z0-9._/-]*$/, "letters, digits and . _ - / only").refine((p) => !p.split("/").includes(".."), "no ..");

/** A remote folder an app can use as a volume. The password is not part of it: it is set on the server and never read back. */
export const volumeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("smb"),
    host: hostName,
    share: z.string().min(1).max(80).regex(/^[A-Za-z0-9._$-]+$/, "letters, digits and . _ $ - only"),
    /** A folder inside the share. */
    path: safePath.optional(),
    user: z.string().min(1).max(80).regex(/^[A-Za-z0-9._@-]+$/, "letters, digits and . _ @ - only"),
    domain: z.string().max(80).regex(/^[A-Za-z0-9._-]*$/).optional(),
    port: z.number().int().positive().max(65535).optional(),
  }),
  z.object({
    type: z.literal("nfs"),
    host: hostName,
    export: safePath.refine((p) => p.startsWith("/"), "expected an absolute path"),
    version: z.enum(["3", "4", "4.1", "4.2"]).default("4"),
  }),
]);
export type Volume = z.infer<typeof volumeSchema>;

export const serviceSchema = z
  .object({
    /** Run this command directly on the host. Exactly one of `command` and `image` is required. */
    command: z.string().min(1).optional(),
    /** Run this container image (with Podman) instead of a host command. */
    image: z.string().max(255).regex(IMAGE_RE, "expected an image reference such as ghcr.io/org/app:1.2").optional(),
    /** The port the image listens on inside the container. Defaults to the port Freighter assigns (`$PORT`). */
    containerPort: z.number().int().positive().max(65535).optional(),
    /** Persistent volumes for an image: a name mapped to an absolute path inside the container. */
    volumes: z
      .record(ident, z.string().regex(/^\/[A-Za-z0-9_./-]*$/, "expected an absolute path inside the container"))
      .optional(),
    port: z.number().int().positive().optional(),
  replicas: z.number().int().positive().default(1),
  resources: z
    .object({
      memory: z.string().regex(/^\d+[KMG]$/).optional(),
      cpu: z.number().positive().max(64).optional(),
    })
    .optional(),
  healthcheck: z
    .object({
      path: z.string().startsWith("/"),
      interval: duration.default("10s"),
      /** How long a fresh release may take to become healthy. */
      timeout: duration.default("30s"),
    })
    .optional(),
  restart: z.enum(["always", "on-failure", "no"]).default("on-failure"),
  /** For routed services: how long HAProxy waits on the service (uploads, streaming, slow responses). */
  proxy: z.object({ timeout: duration }).optional(),
  /** Plain values for this service: the initial ones, which more can be added to from the dashboard. May contain references. */
  environment: z.record(envKey, z.string()).default({}),
  /** Names of this service's secrets. Their values are set on the server and never appear in app.yaml. */
  secrets: z.array(envKey).default([]),
  })
  .superRefine((s, ctx) => {
    if ((s.command === undefined) === (s.image === undefined)) {
      ctx.addIssue({ code: "custom", message: "set exactly one of `command` and `image`" });
    }
    if (s.image === undefined) {
      if (s.containerPort !== undefined) ctx.addIssue({ code: "custom", path: ["containerPort"], message: "containerPort only applies to image services" });
      for (const [name, path] of Object.entries(s.volumes ?? {})) {
        if (FORBIDDEN_TARGETS.some((p) => path === p || path.startsWith(`${p}/`))) {
          ctx.addIssue({ code: "custom", path: ["volumes", name], message: `${path} is a system directory; pick another path` });
        }
      }
    }
  });

const manifestBase = z.object({
    name: ident,
    source: z
      .object({ type: z.literal("git"), repository: z.string(), branch: z.string().default("main") })
      .optional(),
    build: z
      .object({
        commands: z.array(z.string().min(1)),
        /** Build limits (enforced by the sandbox that runs the commands). */
        timeout: duration.default("15m"),
        memory: z.string().regex(/^\d+[KMG]$/).default("2G"),
        cpu: z.number().positive().max(64).default(2),
      })
      .optional(),
    services: z.record(ident, serviceSchema),
    /** Volumes that live on another machine (SMB, NFS). A name a service attaches that is not here is a plain folder of the app. */
    volumes: z.record(ident, volumeSchema).default({}),
    releases: z.object({ keep: z.number().int().min(2).default(5) }).default({ keep: 5 }),
});

function crossCheck(m: z.infer<typeof manifestBase>, ctx: z.RefinementCtx) {
  if (SHARED_VOLUME in m.volumes) ctx.addIssue({ code: "custom", path: ["volumes", SHARED_VOLUME], message: `"${SHARED_VOLUME}" is the app's shared directory; pick another name` });
  for (const [name, svc] of Object.entries(m.services)) {
    if (SHARED_VOLUME in (svc.volumes ?? {})) ctx.addIssue({ code: "custom", path: ["services", name, "volumes", SHARED_VOLUME], message: `"${SHARED_VOLUME}" is the app's shared directory; pick another name` });
    for (const s of svc.secrets) {
      if (s in svc.environment) {
        ctx.addIssue({ code: "custom", path: ["services", name, "secrets"], message: `${s} is both an environment value and a secret` });
      }
    }
    // Connections to this app's own services can be checked here; other apps' are checked when the app is deployed.
    for (const [key, value] of Object.entries(svc.environment)) {
      for (const ref of findReferences(value)) {
        if (ref.volume !== undefined) {
          if (ref.volume !== SHARED_VOLUME && !(ref.volume in m.volumes) && !Object.values(m.services).some((s) => ref.volume in (s.volumes ?? {}))) {
            ctx.addIssue({ code: "custom", path: ["services", name, "environment", key], message: `${ref.text}: this app has no volume "${ref.volume}"` });
          }
          continue;
        }
        if (ref.storage !== undefined || (ref.app !== undefined && ref.app !== m.name)) continue;
        const path = ["services", name, "environment", key];
        const target = m.services[ref.service];
        if (!target) {
          ctx.addIssue({ code: "custom", path, message: `${ref.text}: this app has no service "${ref.service}"` });
        } else if (isEnvAttr(ref.attr) && !(ref.attr in target.environment)) {
          ctx.addIssue({ code: "custom", path, message: `${ref.text}: ${ref.attr} is not set in the environment of ${ref.service} (secrets can't be referenced)` });
        }
      }
    }
  }
}

/**
 * Domains are not part of app.yaml: they are configured on the app itself (dashboard, API or CLI) and stored next to
 * it on its server. A domain routes a hostname to one of the manifest's services.
 */
export const domainSchema = z.object({
  hostname: z.string().regex(HOSTNAME_RE, "expected a lowercase DNS name (no wildcards)"),
  service: ident,
  tls: z.enum(["auto", "off"]).default("auto"),
});
export const domainsSchema = z.array(domainSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const d of list) {
    if (seen.has(d.hostname)) ctx.addIssue({ code: "custom", message: `duplicate hostname ${d.hostname}` });
    seen.add(d.hostname);
  }
});
export type Domain = z.infer<typeof domainSchema>;
export type DomainInput = z.input<typeof domainSchema>;

export const manifestSchema = manifestBase.superRefine(crossCheck);

/**
 * Everything `app.yaml` can define except the name (which is the app's) and `source` (which is the repository link).
 * Freighter stores these for apps whose repository has no `app.yaml`, so the same options can be set from the UI.
 */
export const settingsSchema = manifestBase.omit({ name: true, source: true }).strict();
export type ManifestSettings = z.input<typeof settingsSchema>;

export type Manifest = z.infer<typeof manifestSchema>;
export type Service = z.infer<typeof serviceSchema>;

/** Services that a domain routes to: they run as side-by-side instances on allocated ports. */
export function routedServices(domains: readonly Pick<Domain, "service">[]): Set<string> {
  return new Set(domains.map((d) => d.service));
}

/** Errors that only show once a manifest meets an app's domains (empty when consistent). */
export function routingProblems(m: Pick<Manifest, "services">, domains: readonly Domain[]): string[] {
  return domains.filter((d) => !(d.service in m.services)).map((d) => `domain ${d.hostname} points at service "${d.service}", which this app.yaml does not define`);
}

/** Things worth flagging that do not stop a deploy. */
export function routingWarnings(m: Pick<Manifest, "services">, domains: readonly Domain[]): string[] {
  const routed = routedServices(domains);
  return Object.entries(m.services)
    .filter(([name, svc]) => svc.healthcheck && svc.port === undefined && !routed.has(name))
    .map(([name]) => `service ${name}: the healthcheck is skipped until it has a port or a domain`);
}

/** Image services of a manifest: service name -> image reference as written in app.yaml. */
export function imageServices(manifest: Pick<Manifest, "services">): Record<string, string> {
  return Object.fromEntries(Object.entries(manifest.services).flatMap(([name, s]) => (s.image !== undefined ? [[name, s.image]] : [])));
}

/** The registry a reference lives on: its first path component when that looks like a host, else Docker Hub. */
export function imageHost(ref: string): string {
  const first = ref.split("/")[0]!;
  const hasPath = ref.includes("/");
  return hasPath && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}

