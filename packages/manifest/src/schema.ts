import { z } from "zod";

/** Lowercase identifier: segments of [a-z0-9] joined by single hyphens, starting with a letter. */
export const IDENT_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

const ident = z.string().regex(IDENT_RE, "expected lowercase letters, digits and single hyphens");
const envKey = z.string().regex(ENV_KEY_RE, "expected UPPER_SNAKE_CASE");
const duration = z.string().regex(/^\d+(ms|s|m|h)$/, "expected e.g. 10s");

export const serviceSchema = z.object({
  command: z.string().min(1),
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
