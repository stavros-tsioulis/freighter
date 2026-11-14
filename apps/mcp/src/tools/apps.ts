import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiGet } from "../api.ts";
import { CHARACTER_LIMIT } from "../constants.ts";
import { ago, bytes, listResult, ok, Pagination, respond, ResponseFormat, stateOf, tail } from "../format.ts";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

interface Service {
  name: string;
  port: number | null;
  hostnames: string[];
  activeState: string;
  subState: string;
  restarts: number;
  memoryBytes: number | null;
}
interface App {
  name: string;
  server: string;
  status: string;
  currentRelease: string | null;
  previousRelease: string | null;
  projectId: string | null;
  kind?: string;
  syncedAt: string | null;
  services: Service[];
  deployments?: { id: string; action: string; status: string; releaseId: string | null; createdAt: string }[];
}
interface Project {
  id: string;
  name: string;
  description: string;
  appCount: number;
}

const running = (a: App) => `${a.services.filter((s) => s.activeState === "active").length}/${a.services.length}`;

export function registerAppTools(server: McpServer): void {
  server.registerTool(
    "freighter_list_apps",
    {
      title: "List apps",
      description: `List the apps Freighter runs, with their server, state, services running, current release and first domain.

Use this first to find app names. Filter by project or server. Use freighter_get_app for the services of one app.
Example: "what is deployed?" -> no arguments. "apps on contabo-1" -> server="contabo-1".`,
      inputSchema: z.strictObject({
        project: z.string().optional().describe("Only the apps in this project (by name)"),
        server: z.string().optional().describe("Only the apps on this server"),
        ...Pagination,
        response_format: ResponseFormat,
      }),
      annotations: READ,
    },
    async ({ project, server: onServer, limit, offset, response_format }, ctx) => {
      const [{ apps }, projects] = await Promise.all([apiGet<{ apps: App[] }>("/apps", {}, ctx.mcpReq.signal), project ? apiGet<{ projects: Project[] }>("/projects", {}, ctx.mcpReq.signal) : Promise.resolve({ projects: [] as Project[] })]);
      let projectId: string | undefined;
      if (project) {
        projectId = projects.projects.find((p) => p.name === project || p.id === project)?.id;
        if (!projectId) throw new Error(`No project named "${project}". Use freighter_list_projects to see the projects.`);
      }
      const shown = apps.filter((a) => a.kind !== "storage" && (!projectId || a.projectId === projectId) && (!onServer || a.server === onServer));
      return listResult({
        title: "Apps",
        items: shown,
        limit,
        offset,
        format: response_format,
        key: "apps",
        empty: "No apps yet. freighter_deploy_image creates one from a container image.",
        line: (a) => `## ${a.name}\n- Server: ${a.server}\n- State: ${a.status}, services running ${running(a)}\n- Release: ${a.currentRelease ?? "none"}\n- Domain: ${a.services.flatMap((s) => s.hostnames)[0] ?? "none"}`,
        json: (a) => ({ name: a.name, server: a.server, state: a.status, release: a.currentRelease, services_running: running(a), domain: a.services.flatMap((s) => s.hostnames)[0] ?? null }),
      });
    },
  );

  server.registerTool(
    "freighter_get_app",
    {
      title: "Get an app",
      description: `Everything about one app: where it runs, its release and previous one, its services (state, restarts, memory, address) and its latest deployments.

Use it to see whether an app is healthy. A service that is "retrying" has crashed and is being started again: read its log with freighter_get_logs.`,
      inputSchema: z.strictObject({ app: z.string().min(1).describe("The app's name, e.g. 'shop'"), response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ app, response_format }, ctx) => {
      const a = await apiGet<App>(`/apps/${encodeURIComponent(app)}`, {}, ctx.mcpReq.signal);
      const services = a.services.map((s) => ({ name: s.name, state: stateOf(s), restarts: s.restarts, memory_bytes: s.memoryBytes, port: s.port, domains: s.hostnames }));
      const data = { name: a.name, server: a.server, state: a.status, release: a.currentRelease, previous_release: a.previousRelease, services, latest_deployments: (a.deployments ?? []).map((d) => ({ id: d.id, action: d.action, status: d.status, release: d.releaseId, created_at: d.createdAt })) };
      const md = [
        `# ${a.name}`,
        `- Server: ${a.server}`,
        `- State: ${a.status}`,
        `- Release: ${a.currentRelease ?? "none"}${a.previousRelease ? ` (previous ${a.previousRelease})` : ""}`,
        "",
        "## Services",
        ...services.map((s) => `- **${s.name}**: ${s.state}, ${s.restarts} restarts, ${bytes(s.memory_bytes)}${s.domains.length ? `, ${s.domains.join(", ")}` : ""}${s.port ? `, port ${s.port}` : ""}`),
        "",
        "## Latest deployments",
        ...(data.latest_deployments.length ? data.latest_deployments.map((d) => `- ${d.id.slice(0, 8)} ${d.action} ${d.status}${d.release ? ` ${d.release}` : ""} (${ago(d.created_at)})`) : ["- none"]),
      ].join("\n");
      return respond(response_format, md, data);
    },
  );

  server.registerTool(
    "freighter_list_releases",
    {
      title: "List an app's releases",
      description: "List the releases of an app, newest first, with which is current. Use it before freighter_rollback to pick a release.",
      inputSchema: z.strictObject({ app: z.string().min(1).describe("The app's name"), ...Pagination, response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ app, limit, offset, response_format }, ctx) => {
      const { releases } = await apiGet<{ releases: { id: string; current: boolean; result?: string }[] }>(`/apps/${encodeURIComponent(app)}/releases`, {}, ctx.mcpReq.signal);
      const sorted = [...releases].sort((a, b) => (a.id < b.id ? 1 : -1));
      return listResult({ title: `Releases of ${app}`, items: sorted, limit, offset, format: response_format, key: "releases", empty: `${app} has no releases.`, line: (r) => `- ${r.id}${r.current ? " (current)" : ""}${r.result ? ` — ${r.result}` : ""}` });
    },
  );

  server.registerTool(
    "freighter_get_logs",
    {
      title: "Read a service's log",
      description: `The most recent log lines of one service from the journal, or of every service of the app when none is named (each line tagged with its service).

Use it to find out why a service crashes or misbehaves. Needs the deployer role.
Example: "why does shop/web keep restarting?" -> app="shop", service="web", lines=200.`,
      inputSchema: z.strictObject({
        app: z.string().min(1).describe("The app's name"),
        service: z.string().optional().describe("One service; without it, all of the app's services"),
        lines: z.number().int().min(1).max(1000).default(100).describe("How many recent lines per service (1-1000)"),
      }),
      annotations: READ,
    },
    async ({ app, service, lines }, ctx) => {
      const names = service ? [service] : (await apiGet<App>(`/apps/${encodeURIComponent(app)}`, {}, ctx.mcpReq.signal)).services.map((s) => s.name);
      if (names.length === 0) return ok(`${app} has no services yet.`);
      const parts = await Promise.all(names.map(async (s) => ({ s, text: (await apiGet<{ text: string }>(`/apps/${encodeURIComponent(app)}/logs`, { service: s, lines }, ctx.mcpReq.signal)).text })));
      const body = parts.map(({ s, text }) => (names.length > 1 ? text.split("\n").filter(Boolean).map((l) => `[${s}] ${l}`).join("\n") : text.trimEnd())).join("\n");
      return ok(body ? tail(body, CHARACTER_LIMIT).text : "The log is empty.");
    },
  );

  server.registerTool(
    "freighter_get_stats",
    {
      title: "Memory and CPU of an app's services",
      description: "Latest and peak memory, CPU and restart count per service over a recent window. Use it to spot a service that leaks memory or burns CPU.",
      inputSchema: z.strictObject({ app: z.string().min(1).describe("The app's name"), minutes: z.number().int().min(1).max(360).default(60).describe("How far back to look, in minutes"), response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ app, minutes, response_format }, ctx) => {
      const r = await apiGet<{ series: Record<string, { memoryBytes: number | null; cpuPercent: number | null; restarts: number }[]> }>(`/apps/${encodeURIComponent(app)}/metrics`, { minutes }, ctx.mcpReq.signal);
      const rows = Object.entries(r.series).map(([service, s]) => ({
        service,
        memory_bytes: s.at(-1)?.memoryBytes ?? null,
        peak_memory_bytes: s.length ? Math.max(...s.map((x) => x.memoryBytes ?? 0)) : null,
        cpu_percent: s.at(-1)?.cpuPercent ?? null,
        peak_cpu_percent: s.length ? Math.max(...s.map((x) => x.cpuPercent ?? 0)) : null,
        restarts: s.at(-1)?.restarts ?? 0,
      }));
      if (rows.length === 0) return respond(response_format, `No samples for ${app} in the last ${minutes} minutes.`, { app, minutes, services: [] });
      const md = [`# ${app}, last ${minutes} minutes`, ...rows.map((x) => `- **${x.service}**: ${bytes(x.memory_bytes)} (peak ${bytes(x.peak_memory_bytes)}), CPU ${x.cpu_percent === null ? "-" : `${Math.round(x.cpu_percent)}%`} (peak ${x.peak_cpu_percent === null ? "-" : `${Math.round(x.peak_cpu_percent)}%`}), ${x.restarts} restarts`)].join("\n");
      return respond(response_format, md, { app, minutes, services: rows });
    },
  );

  server.registerTool(
    "freighter_list_projects",
    {
      title: "List projects",
      description: "List the projects (groups of apps) with their app counts. Pass a project's name to freighter_list_apps to see its apps.",
      inputSchema: z.strictObject({ ...Pagination, response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ limit, offset, response_format }, ctx) => {
      const { projects } = await apiGet<{ projects: Project[] }>("/projects", {}, ctx.mcpReq.signal);
      return listResult({ title: "Projects", items: projects, limit, offset, format: response_format, key: "projects", empty: "No projects.", line: (p) => `- **${p.name}** (${p.appCount} apps)${p.description ? ` — ${p.description}` : ""}` });
    },
  );
}
