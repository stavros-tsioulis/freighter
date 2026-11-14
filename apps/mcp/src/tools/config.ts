import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.ts";
import { CHARACTER_LIMIT } from "../constants.ts";
import { finish, WaitArgs } from "../deployments.ts";
import { listResult, ok, Pagination, respond, ResponseFormat, tail } from "../format.ts";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const app = z.string().min(1).describe("The app's name, e.g. 'shop'");
const KEY = /^[A-Z_][A-Z0-9_]*$/;
const Key = z.string().regex(KEY, "UPPER_SNAKE_CASE, like LOG_LEVEL");

interface Variable {
  service: string;
  key: string;
  value: string;
  resolved: string | null;
  error: string | null;
  source: "service" | "app";
  secret: boolean;
  reference: boolean;
}
interface ConfigView {
  text: string | null;
  settings: Record<string, unknown> | null;
}
interface Domain {
  hostname: string;
  service: string;
  tls: string;
  status: "active" | "pending";
  lastError: string | null;
}

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    "freighter_get_config",
    {
      title: "Get an app's configuration",
      description: "The app's configuration as an app.yaml: its services (command or image, port, environment, secret names, limits), app-level environment and build settings. Secret values are never part of it.",
      inputSchema: z.strictObject({ app }),
      annotations: READ,
    },
    async ({ app: name }, ctx) => {
      const c = await apiGet<ConfigView>(`/apps/${encodeURIComponent(name)}/config`, {}, ctx.mcpReq.signal);
      if (!c.text) throw new Error(`${name} has no configuration yet: it gets one with its first deployment.`);
      return ok(tail(c.text, CHARACTER_LIMIT).text);
    },
  );

  server.registerTool(
    "freighter_list_variables",
    {
      title: "List an app's variables",
      description: `The plain environment variables of an app's services, with where each comes from ('service' or 'app'). Values that point at another service (like @api.url) can be shown resolved.

Secrets are not here (they are write-only): freighter_list_secret_names lists their names.
Example: "what is LOG_LEVEL on shop/web?" -> app="shop", service="web".`,
      inputSchema: z.strictObject({
        app,
        service: z.string().optional().describe("Only this service's variables"),
        resolved: z.boolean().default(false).describe("Also show what connections like @api.url resolve to, and why one can't"),
        ...Pagination,
        response_format: ResponseFormat,
      }),
      annotations: READ,
    },
    async ({ app: name, service, resolved, limit, offset, response_format }, ctx) => {
      const { variables } = await apiGet<{ variables: Variable[] }>(`/apps/${encodeURIComponent(name)}/variables`, {}, ctx.mcpReq.signal);
      const shown = variables.filter((v) => !service || v.service === service);
      return listResult({
        title: `Variables of ${service ? `${name}/${service}` : name}`,
        items: shown,
        limit,
        offset,
        format: response_format,
        key: "variables",
        empty: "No variables.",
        line: (v) => `- ${service ? "" : `${v.service}: `}**${v.key}** = ${v.value} (${v.source})${resolved && v.reference ? ` → ${v.error ? `ERROR: ${v.error}` : v.secret ? "(a credential)" : (v.resolved ?? "")}` : ""}`,
        json: (v) => ({ service: v.service, key: v.key, value: v.value, source: v.source, ...(resolved && v.reference ? { resolved: v.secret ? null : v.resolved, error: v.error } : {}) }),
      });
    },
  );

  server.registerTool(
    "freighter_set_variables",
    {
      title: "Set variables",
      description: `Set plain environment variables on one service, or app-wide for every service (leave service out). Only the service that changed restarts. Values may use connections like '@api.url' or '\${self.OTHER_KEY}'.

Never put a secret here: it would be stored in the configuration in plain text. Secrets are set with the freighter CLI (freighter secret set, which reads the value without echoing it), not through this tool.
Needs the admin role.
Example: "turn on debug logging for shop/web" -> app="shop", service="web", variables={"LOG_LEVEL": "debug"}.`,
      inputSchema: z.strictObject({
        app,
        service: z.string().optional().describe("The service; without it the variables apply to every service of the app"),
        variables: z.record(Key, z.string().max(65_536)).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50, "1 to 50 variables").describe('Names and values, e.g. {"LOG_LEVEL": "debug"}'),
        ...WaitArgs,
      }),
      annotations: CHANGE,
    },
    async ({ app: name, service, variables, wait, timeout_seconds }, ctx) => {
      let last: { id: string } | undefined;
      if (service) {
        for (const [key, value] of Object.entries(variables)) last = await apiPut<{ id: string }>(`/apps/${encodeURIComponent(name)}/services/${encodeURIComponent(service)}/variables/${key}`, { value }, ctx.mcpReq.signal);
      } else last = await changeAppEnvironment(name, (env) => Object.assign(env, variables), ctx.mcpReq.signal);
      return finish(last!, { wait, timeout_seconds }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "freighter_unset_variables",
    {
      title: "Remove variables",
      description: "Remove plain environment variables from one service, or from the app-wide environment (leave service out). Only the service that changed restarts. Needs the admin role.",
      inputSchema: z.strictObject({ app, service: z.string().optional().describe("The service; without it, the app-wide environment"), keys: z.array(Key).min(1).max(50).describe("Names to remove"), ...WaitArgs }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ app: name, service, keys, wait, timeout_seconds }, ctx) => {
      let last: { id: string } | undefined;
      if (service) {
        for (const key of keys) last = await apiDelete<{ id: string }>(`/apps/${encodeURIComponent(name)}/services/${encodeURIComponent(service)}/variables/${key}`, undefined, ctx.mcpReq.signal);
      } else last = await changeAppEnvironment(name, (env) => keys.forEach((k) => delete env[k]), ctx.mcpReq.signal);
      return finish(last!, { wait, timeout_seconds }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "freighter_list_secret_names",
    {
      title: "List a service's secret names",
      description: "The names of a service's secrets and whether each has a value. Never the values: secrets are write-only. A declared secret with no value ('not set') is a common reason a service fails to start.",
      inputSchema: z.strictObject({ app, service: z.string().min(1).describe("The service"), response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ app: name, service, response_format }, ctx) => {
      const { names, declared } = await apiGet<{ names: string[]; declared: string[] }>(`/apps/${encodeURIComponent(name)}/services/${encodeURIComponent(service)}/env`, {}, ctx.mcpReq.signal);
      const all = [...new Set([...declared, ...names])].sort();
      const rows = all.map((n) => ({ name: n, set: names.includes(n), declared: declared.includes(n) }));
      const md = rows.length ? [`# Secrets of ${name}/${service}`, ...rows.map((r) => `- ${r.name}: ${r.set ? "set" : "NOT SET"}`)].join("\n") : `${name}/${service} has no secrets.`;
      return respond(response_format, md, { app: name, service, secrets: rows });
    },
  );

  server.registerTool(
    "freighter_list_domains",
    {
      title: "List an app's domains",
      description: "The hostnames routed to an app's services, and whether each is live or still waiting for its DNS records.",
      inputSchema: z.strictObject({ app, response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ app: name, response_format }, ctx) => {
      const { domains } = await apiGet<{ domains: Domain[] }>(`/apps/${encodeURIComponent(name)}/domains`, {}, ctx.mcpReq.signal);
      const md = domains.length ? [`# Domains of ${name}`, ...domains.map((d) => `- ${d.hostname} → ${d.service} (${d.tls === "auto" ? "HTTPS" : "HTTP only"}): ${d.status === "active" ? "live" : `waiting for DNS${d.lastError ? ` (${d.lastError})` : ""}`}`)].join("\n") : `${name} has no domains. freighter_add_domain adds one.`;
      return respond(response_format, md, { app: name, domains });
    },
  );

  server.registerTool(
    "freighter_add_domain",
    {
      title: "Add a domain",
      description: `Route a hostname to a service. The domain starts out waiting for DNS: the result lists the DNS records to create at the DNS provider. Once they exist, call freighter_verify_domain to put it live (with an HTTPS certificate). Needs the admin role.`,
      inputSchema: z.strictObject({ app, hostname: z.string().min(3).describe("e.g. 'shop.example.com'"), service: z.string().min(1).describe("The service that serves it"), https: z.boolean().default(true).describe("Automatic HTTPS (false: plain HTTP only)") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ app: name, hostname, service, https }, ctx) => {
      const r = await apiPost<{ domain: Domain; dns: { records: { type: string; value: string }[] } }>(`/apps/${encodeURIComponent(name)}/domains`, { hostname, service, tls: https ? "auto" : "off" }, { signal: ctx.mcpReq.signal });
      const records = r.dns.records.length ? r.dns.records.map((x) => `- ${x.type}  ${hostname}  ${x.value}`).join("\n") : "- (this server's public address isn't known: set api.publicIps in its config.yaml)";
      return ok(`Added ${hostname} to ${name}/${service}. At the DNS provider, create:\n${records}\n\nThen call freighter_verify_domain app="${name}" hostname="${hostname}".`);
    },
  );

  server.registerTool(
    "freighter_verify_domain",
    {
      title: "Verify a domain",
      description: "Check a domain's DNS records and, when they are right, put it live (a deployment that issues the certificate). If the records aren't there yet it says what it found; DNS changes can take a few minutes. Needs the admin role.",
      inputSchema: z.strictObject({ app, hostname: z.string().min(3).describe("The hostname added with freighter_add_domain"), ...WaitArgs }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ app: name, hostname, wait, timeout_seconds }, ctx) => {
      const r = await apiPost<{ verified: boolean; id?: string; reason?: string | null; found?: string[]; expected?: string[] }>(`/apps/${encodeURIComponent(name)}/domains/${encodeURIComponent(hostname)}/verify`, {}, { signal: ctx.mcpReq.signal });
      if (!r.verified) {
        const detail = [r.found?.length ? `found ${r.found.join(", ")}` : "", r.expected?.length ? `expected ${r.expected.join(", ")}` : ""].filter(Boolean).join("; ");
        return { content: [{ type: "text", text: `${hostname} isn't ready: ${r.reason ?? "the DNS records don't match"}${detail ? ` (${detail})` : ""}. DNS changes can take a few minutes: try again shortly.` }], isError: true };
      }
      if (!r.id) return ok(`${hostname} is live.`);
      return finish({ id: r.id }, { wait, timeout_seconds }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "freighter_remove_domain",
    {
      title: "Remove a domain",
      description: "Stop routing a hostname to an app, or forget one still waiting for DNS. Only routing changes: nothing is redeployed and the services keep running. Needs the admin role.",
      inputSchema: z.strictObject({ app, hostname: z.string().min(3).describe("The hostname to remove") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ app: name, hostname }, ctx) => {
      await apiDelete(`/apps/${encodeURIComponent(name)}/domains/${encodeURIComponent(hostname)}`, undefined, ctx.mcpReq.signal);
      return ok(`Removed ${hostname} from ${name}.`);
    },
  );
}

/** The app-wide environment lives in the configuration, which is replaced as a whole. */
async function changeAppEnvironment(name: string, change: (env: Record<string, string>) => void, signal: AbortSignal): Promise<{ id: string }> {
  const c = await apiGet<ConfigView>(`/apps/${encodeURIComponent(name)}/config`, {}, signal);
  if (!c.settings) throw new Error(`${name} has no configuration yet: it gets one with its first deployment.`);
  const settings = structuredClone(c.settings) as Record<string, unknown> & { environment?: Record<string, string> };
  settings.environment = settings.environment ?? {};
  change(settings.environment);
  return apiPut<{ id: string }>(`/apps/${encodeURIComponent(name)}/config`, { settings }, signal);
}
