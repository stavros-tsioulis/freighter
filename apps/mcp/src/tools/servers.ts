import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiGet } from "../api.ts";
import { ago, bytes, listResult, ok, Pagination, respond, ResponseFormat } from "../format.ts";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

interface Server {
  name: string;
  kind: "local" | "remote";
  address: string | null;
  status: string;
  agentVersion: string | null;
  host: { cpus?: number; os?: string; uptimeSeconds: number; load1: number; memTotal: number; memFree: number; diskFreeBytes: number | null; diskTotalBytes: number | null } | null;
  lastSeenAt: string | null;
  lastError: string | null;
  appCount: number;
}
interface Rule {
  number: number;
  to: string;
  action: string;
  direction: string;
  from: string;
  comment: string;
  v6: boolean;
}
interface Firewall {
  installed: boolean;
  active: boolean;
  defaults: { incoming: string; outgoing: string } | null;
  rules: Rule[];
  essential: { port: number; what: string }[];
}
interface Storage {
  name: string;
  server: string;
  backend: string;
  [k: string]: unknown;
}
interface Audit {
  id: number;
  at: string;
  tokenId: string | null;
  action: string;
  app: string | null;
  detail: Record<string, unknown>;
}

const describe = (s: Server) => {
  const h = s.host;
  const bits = [`${s.status}`, s.kind, s.address ?? "", `${s.appCount} app${s.appCount === 1 ? "" : "s"}`];
  if (h) bits.push(`load ${h.load1.toFixed(1)}`, `memory ${bytes(h.memTotal - h.memFree)}/${bytes(h.memTotal)}`, h.diskFreeBytes != null ? `disk free ${bytes(h.diskFreeBytes)}` : "");
  if (s.lastError) bits.push(`last error: ${s.lastError}`);
  return `- **${s.name}**: ${bits.filter(Boolean).join(", ")}`;
};

export function registerServerTools(server: McpServer): void {
  server.registerTool(
    "freighter_whoami",
    {
      title: "Who this token is",
      description: "The identity and role (viewer, deployer or admin) of the token this server uses, and which Freighter it talks to. Check it first when a call is refused for permissions.",
      inputSchema: z.strictObject({}),
      annotations: READ,
    },
    async (_args, ctx) => {
      const who = await apiGet<{ id: string; name: string; role: string }>("/session", {}, ctx.mcpReq.signal);
      return ok(`Signed in as "${who.name}" with the ${who.role} role.`);
    },
  );

  server.registerTool(
    "freighter_list_servers",
    {
      title: "List servers",
      description: "The servers apps run on: whether each is online, its load, memory, free disk and how many apps it hosts.",
      inputSchema: z.strictObject({ ...Pagination, response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ limit, offset, response_format }, ctx) => {
      const { servers } = await apiGet<{ servers: Server[] }>("/servers", {}, ctx.mcpReq.signal);
      return listResult({ title: "Servers", items: servers, limit, offset, format: response_format, key: "servers", empty: "No servers.", line: describe });
    },
  );

  server.registerTool(
    "freighter_get_server",
    {
      title: "Get a server",
      description: "One server in detail: state, last contact, agent version, host resources.",
      inputSchema: z.strictObject({ server: z.string().min(1).describe("The server's name"), response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ server: name, response_format }, ctx) => {
      const s = await apiGet<Server>(`/servers/${encodeURIComponent(name)}`, {}, ctx.mcpReq.signal);
      const extra = [s.agentVersion ? `agent ${s.agentVersion.slice(0, 7)}` : "", s.lastSeenAt ? `last seen ${ago(s.lastSeenAt)}` : "", s.host?.os ?? "", s.host ? `${s.host.cpus ?? "?"} CPUs` : ""].filter(Boolean).join(", ");
      return respond(response_format, `${describe(s)}${extra ? `\n  ${extra}` : ""}`, { ...s });
    },
  );

  server.registerTool(
    "freighter_get_firewall",
    {
      title: "Get a server's firewall",
      description: "A server's firewall (ufw): whether it is active, the default policies and every rule, plus the ports Freighter needs open. Read-only: changing rules can lock everyone out of the server, so that is done with the freighter CLI.",
      inputSchema: z.strictObject({ server: z.string().min(1).describe("The server's name"), response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ server: name, response_format }, ctx) => {
      const f = await apiGet<Firewall>(`/servers/${encodeURIComponent(name)}/firewall`, {}, ctx.mcpReq.signal);
      if (!f.installed) return respond(response_format, `${name} has no firewall installed (ufw).`, { ...f });
      const rules = f.rules.filter((r) => !r.v6).map((r) => `${r.number}. ${r.action} ${r.direction} ${r.to} from ${r.from}${r.comment ? ` (${r.comment})` : ""}`);
      const md = [`# Firewall of ${name}: ${f.active ? "active" : "inactive"}`, f.defaults ? `Defaults: incoming ${f.defaults.incoming}, outgoing ${f.defaults.outgoing}` : "", rules.length ? rules.join("\n") : "No rules.", f.essential.length ? `Needed open: ${f.essential.map((e) => `${e.port} (${e.what})`).join(", ")}` : ""].filter(Boolean).join("\n");
      return respond(response_format, md, { ...f });
    },
  );

  server.registerTool(
    "freighter_list_storages",
    {
      title: "List storages",
      description: "The storage backends apps can mount or back up to (S3-compatible, SFTP, local).",
      inputSchema: z.strictObject({ ...Pagination, response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ limit, offset, response_format }, ctx) => {
      const { storages } = await apiGet<{ storages: Storage[] }>("/storages", {}, ctx.mcpReq.signal);
      return listResult({ title: "Storages", items: storages, limit, offset, format: response_format, key: "storages", empty: "No storages.", line: (s) => `- **${s.name}**: ${s.backend} on ${s.server}` });
    },
  );

  server.registerTool(
    "freighter_get_audit_log",
    {
      title: "Read the audit log",
      description: "Who did what, newest first: deployments, variable changes, console sessions, token use. Use it to find out what changed before something broke.",
      inputSchema: z.strictObject({ app: z.string().optional().describe("Only this app's entries"), action: z.string().optional().describe("Only entries whose action contains this text, e.g. 'deploy'"), ...Pagination, response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ app, action, limit, offset, response_format }, ctx) => {
      const { entries } = await apiGet<{ entries: Audit[] }>("/audit", { limit: 500 }, ctx.mcpReq.signal);
      const shown = entries.filter((e) => (!app || e.app === app) && (!action || e.action.includes(action)));
      return listResult({
        title: "Audit log",
        items: shown,
        limit,
        offset,
        format: response_format,
        key: "entries",
        empty: "No matching entries.",
        line: (e) => `- ${e.at} ${e.action}${e.app ? ` on ${e.app}` : ""}${Object.keys(e.detail).length ? ` ${JSON.stringify(e.detail).slice(0, 200)}` : ""}`,
      });
    },
  );
}
