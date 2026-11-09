import { z } from "zod";
import { findReferences, isEnvAttr } from "./reference.ts";

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
  })
  .superRefine((s, ctx) => {
    if ((s.command === undefined) === (s.image === undefined)) {
      ctx.addIssue({ code: "custom", message: "set exactly one of `command` and `image`" });
    }
    if (s.image === undefined) {
      if (s.containerPort !== undefined) ctx.addIssue({ code: "custom", path: ["containerPort"], message: "containerPort only applies to image services" });
      if (s.volumes !== undefined) ctx.addIssue({ code: "custom", path: ["volumes"], message: "volumes only apply to image services" });
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
    environment: z.record(envKey, z.string()).default({}),
    secrets: z.array(envKey).default([]),
    releases: z.object({ keep: z.number().int().min(2).default(5) }).default({ keep: 5 }),
});

function crossCheck(m: z.infer<typeof manifestBase>, ctx: z.RefinementCtx) {
  for (const s of m.secrets) {
    if (s in m.environment) {
      ctx.addIssue({ code: "custom", path: ["secrets"], message: `${s} is both an environment value and a secret` });
    }
  }
  // Connections to this app's own services can be checked here; other apps' are checked when the app is deployed.
  for (const [key, value] of Object.entries(m.environment)) {
    for (const ref of findReferences(value)) {
      if (ref.app !== undefined && ref.app !== m.name) continue;
      const path = ["environment", key];
      if (!(ref.service in m.services)) {
        ctx.addIssue({ code: "custom", path, message: `${ref.text}: this app has no service "${ref.service}"` });
      } else if (isEnvAttr(ref.attr) && !(ref.attr in m.environment)) {
        ctx.addIssue({ code: "custom", path, message: `${ref.text}: ${ref.attr} is not set in environment (secrets can't be referenced)` });
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

