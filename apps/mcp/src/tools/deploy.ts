import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { api, apiGet, apiPost } from "../api.ts";
import { CHARACTER_LIMIT } from "../constants.ts";
import { type Deployment, describe, finish, WaitArgs } from "../deployments.ts";
import { listResult, ok, Pagination, respond, ResponseFormat, tail } from "../format.ts";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const app = z.string().min(1).describe("The app's name, e.g. 'shop'");

export function registerDeployTools(server: McpServer): void {
  server.registerTool(
    "freighter_list_deployments",
    {
      title: "List deployments",
      description: `Recent deployments, rollbacks and configuration changes, newest first, for one app or all of them.

Use it to see what changed recently and what failed. Open one with freighter_get_deployment.
Example: "did the last deploy of shop work?" -> app="shop", limit=3.`,
      inputSchema: z.strictObject({
        app: z.string().optional().describe("Only this app's (default: every app)"),
        status: z.enum(["queued", "running", "success", "failed"]).optional().describe("Only deployments in this state"),
        ...Pagination,
        response_format: ResponseFormat,
      }),
      annotations: READ,
    },
    async ({ app: name, status, limit, offset, response_format }, ctx) => {
      const { deployments } = await apiGet<{ deployments: Deployment[] }>(name ? `/apps/${encodeURIComponent(name)}/deployments` : "/deployments", { limit: 100 }, ctx.mcpReq.signal);
      const shown = deployments.filter((d) => !status || d.status === status);
      return listResult({
        title: name ? `Deployments of ${name}` : "Deployments",
        items: shown,
        limit,
        offset,
        format: response_format,
        key: "deployments",
        empty: "No deployments match.",
        line: (d) => `- ${d.id.slice(0, 8)} ${d.app} ${d.action} **${d.status}**${d.releaseId ? ` ${d.releaseId}` : ""}${d.error ? ` — ${d.error.split("\n")[0]}` : ""}`,
        json: (d) => ({ id: d.id, app: d.app, action: d.action, status: d.status, release: d.releaseId, error: d.error?.split("\n")[0] ?? null, created_at: d.createdAt }),
      });
    },
  );

  server.registerTool(
    "freighter_get_deployment",
    {
      title: "Get a deployment",
      description: "One deployment: what it did, how it ended, the error if it failed, and its steps. The id may be the full id or the first characters of it (as freighter_list_deployments shows).",
      inputSchema: z.strictObject({ id: z.string().min(4).describe("A deployment id, or its first characters"), response_format: ResponseFormat }),
      annotations: READ,
    },
    async ({ id, response_format }, ctx) => {
      const full = await fullId(id, ctx.mcpReq.signal);
      const d = await apiGet<Deployment>(`/deployments/${full}`, {}, ctx.mcpReq.signal);
      const log = await apiGet<{ text: string }>(`/deployments/${full}/log`, {}, ctx.mcpReq.signal).catch(() => ({ text: "" }));
      const stepLines = log.text.split("\n").filter((l) => l.startsWith("==> ")).map((l) => l.slice(4));
      return respond(response_format, describe(d, stepLines), { ...d, steps: stepLines });
    },
  );

  server.registerTool(
    "freighter_get_deployment_log",
    {
      title: "Read a deployment's log",
      description: "The log of a deployment (build output, each step of the release, health-check results). Long logs are cut from the front: the end, where a failure shows, is kept. Needs the deployer role.",
      inputSchema: z.strictObject({ id: z.string().min(4).describe("A deployment id, or its first characters"), tail_lines: z.number().int().min(10).max(5000).default(300).describe("How many of the last lines to return") }),
      annotations: READ,
    },
    async ({ id, tail_lines }, ctx) => {
      const full = await fullId(id, ctx.mcpReq.signal);
      let from = 0;
      let all = "";
      for (let i = 0; i < 200; i++) {
        const r = await apiGet<{ text: string; next: number; done: boolean }>(`/deployments/${full}/log`, { from }, ctx.mcpReq.signal);
        all += r.text;
        from = r.next;
        if (r.done || !r.text) break;
      }
      const lines = all.split("\n");
      return ok(tail(lines.slice(-tail_lines).join("\n"), CHARACTER_LIMIT).text || "The log is empty.");
    },
  );

  server.registerTool(
    "freighter_deploy_image",
    {
      title: "Deploy a container image",
      description: `Create an app from a container image, or deploy a new image (usually a new tag) to an existing app, and wait for the result.

The server pulls the image, starts it, health-checks it and switches traffic; a failed release rolls back by itself. This sets the app's configuration to one service ('web') running the image. For an app with several services or settings, change its configuration instead (freighter_set_variables, or the CLI's config apply).
Registry logins must already exist (see the CLI's registry add). Needs the deployer role.
Example: "deploy ghcr.io/acme/shop:1.4 as shop on port 3000" -> app="shop", image="ghcr.io/acme/shop:1.4", port=3000.`,
      inputSchema: z.strictObject({
        app,
        image: z.string().min(1).describe("Image reference, e.g. 'ghcr.io/acme/shop:1.4' or 'nginx'"),
        port: z.number().int().min(1).max(65535).optional().describe("The port the app listens on inside the container, if the image doesn't say"),
        server: z.string().optional().describe("Which server a NEW app goes on (an existing app stays where it is)"),
        login: z.string().optional().describe("Which registry login pulls it, as '<host>=<username>', when the registry has several"),
        ...WaitArgs,
      }),
      annotations: CHANGE,
    },
    async ({ app: name, image, port, server: on, login, wait, timeout_seconds }, ctx) => {
      const manifest = `name: ${name}\nservices:\n  web:\n    image: ${image}\n${port !== undefined ? `    port: ${port}\n` : ""}`;
      let logins: Record<string, string> | undefined;
      if (login) {
        const [host, ...user] = login.split("=");
        if (!host || !user.join("=")) throw new Error(`login must be '<host>=<username>', like 'ghcr.io=alice' (got '${login}').`);
        logins = { [host]: user.join("=") };
      }
      const q = await api<{ id: string }>("POST", `/apps/${encodeURIComponent(name)}/image-deployments`, { body: { manifest, replaceConfig: true, ...(logins ? { logins } : {}) }, query: on ? { server: on } : undefined, signal: ctx.mcpReq.signal });
      return finish(q, { wait, timeout_seconds }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "freighter_redeploy",
    {
      title: "Redeploy an app",
      description: "Release an app again with its current configuration: images are pulled again (to pick up a moved tag), and an app built from Git is built from the branch head. Use it after changing a secret, or to pick up a new `latest`. Needs the deployer role.",
      inputSchema: z.strictObject({ app, ...WaitArgs }),
      annotations: CHANGE,
    },
    async ({ app: name, wait, timeout_seconds }, ctx) => {
      const linked = await apiGet(`/apps/${encodeURIComponent(name)}/git`, {}, ctx.mcpReq.signal).then(() => true, () => false);
      const q = await apiPost<{ id: string }>(`/apps/${encodeURIComponent(name)}/${linked ? "git/deploy" : "redeploy"}`, {}, { signal: ctx.mcpReq.signal });
      return finish(q, { wait, timeout_seconds }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "freighter_rollback",
    {
      title: "Roll an app back",
      description: "Go back to the previous release of an app, or to a named one (see freighter_list_releases). The configuration goes back with it. Needs the deployer role.",
      inputSchema: z.strictObject({ app, release: z.string().regex(/^r\d{8}-\d{6}(-\d+)?$/).optional().describe("A release id like 'r20261114-101502'; default: the previous one"), ...WaitArgs }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ app: name, release, wait, timeout_seconds }, ctx) => {
      const q = await apiPost<{ id: string }>(`/apps/${encodeURIComponent(name)}/rollback`, release ? { release } : {}, { signal: ctx.mcpReq.signal });
      return finish(q, { wait, timeout_seconds }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "freighter_cancel_deployment",
    {
      title: "Cancel a deployment",
      description: "Stop a deployment that is queued or running. The previous release keeps running. A deployment that has already ended can't be canceled.",
      inputSchema: z.strictObject({ id: z.string().min(4).describe("A deployment id, or its first characters") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id }, ctx) => {
      const full = await fullId(id, ctx.mcpReq.signal);
      await apiPost(`/deployments/${full}/cancel`, {}, { signal: ctx.mcpReq.signal });
      return ok(`Canceled deployment ${full.slice(0, 8)}; the previous release keeps running.`);
    },
  );

  server.registerTool(
    "freighter_control_service",
    {
      title: "Start, stop or restart services",
      description: `Start, stop or restart one service of an app, or all of them. A routed service drops requests briefly while it restarts; a stopped one serves nothing until it is started.

Use "restart" after a change that needs one, or to clear a stuck process; check the result with freighter_get_app. Needs the deployer role.`,
      inputSchema: z.strictObject({ app, service: z.string().optional().describe("One service; without it, all of the app's"), action: z.enum(["start", "stop", "restart"]).describe("What to do") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ app: name, service, action }, ctx) => {
      const r = await apiPost<{ units: string[] }>(`/apps/${encodeURIComponent(name)}/${action}`, service ? { service } : {}, { signal: ctx.mcpReq.signal });
      return ok(`${action === "stop" ? "Stopped" : action === "start" ? "Started" : "Restarted"} ${service ? `${name}/${service}` : name} (${r.units.length} service${r.units.length === 1 ? "" : "s"}).`);
    },
  );
}

/** A deployment's full id, from the first characters of it (as listings show them). */
async function fullId(id: string, signal: AbortSignal): Promise<string> {
  if (/^[0-9a-f-]{36}$/.test(id)) return id;
  const { deployments } = await apiGet<{ deployments: Deployment[] }>("/deployments", { limit: 200 }, signal);
  const found = deployments.filter((d) => d.id.startsWith(id));
  if (found.length === 0) throw new Error(`No deployment starts with "${id}". freighter_list_deployments shows recent ids.`);
  if (found.length > 1) throw new Error(`"${id}" matches ${found.length} deployments; give more of the id.`);
  return found[0]!.id;
}
