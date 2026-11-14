import { defineCommand } from "citty";
import type { Api } from "../lib/api.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { ago, duration } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";
import { target } from "../lib/target.ts";
import { follow, type Deployment } from "../lib/wait.ts";
import { projectByName } from "./apps.ts";

// ---- release ----

interface Release {
  id: string;
  current: boolean;
  result?: string;
  at?: string;
}

const releaseList = defineCommand({
  meta: { name: "list", description: "The releases of an app, newest first" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const { releases } = await api().get<{ releases: Release[] }>(`/apps/${app}/releases`);
      const sorted = [...releases].sort((a, b) => (a.id < b.id ? 1 : -1));
      out.ids(sorted.map((r) => r.id), sorted, () => {
        if (sorted.length === 0) return out.note(`${app} has no releases`);
        out.table(["RELEASE", "CURRENT", "WHEN", "RESULT"], sorted.map((r) => [r.id, r.current ? "yes" : "", ago(r.at), r.result ?? ""]));
      });
    }),
});

export const release = defineCommand({ meta: { name: "release", description: "The releases of an app" }, subCommands: { list: releaseList } });

// ---- deployment ----

const status = (out: { paint: (s: "red" | "green" | "yellow", t: string) => string }, d: Deployment) => (d.status === "failed" ? out.paint("red", d.status) : d.status === "success" ? d.status : out.paint("yellow", d.status));

const deploymentList = defineCommand({
  meta: { name: "list", description: "Recent deployments, rollbacks and config changes" },
  args: {
    app: { type: "positional", required: false, description: "Only this app's (default: all of them)" },
    n: { type: "string", alias: "n", description: "How many", default: "20" },
    failed: { type: "boolean", description: "Only the ones that failed" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const limit = Number(args.n);
      if (!Number.isInteger(limit) || limit < 1) throw usage("-n is a number");
      const { deployments } = await api().get<{ deployments: Deployment[] }>(args.app ? `/apps/${target(args.app).app}/deployments` : "/deployments", { limit });
      const shown = deployments.filter((d) => !args.failed || d.status === "failed").slice(0, limit);
      out.ids(shown.map((d) => d.id), shown, () => {
        if (shown.length === 0) return out.note("no deployments");
        out.table(["ID", "APP", "ACTION", "STATUS", "RELEASE", "WHEN"], shown.map((d) => [d.id.slice(0, 8), d.app, d.action, status(out, d), d.releaseId ?? "", ago(d.createdAt)]));
      });
    }),
});

/** A full id, or the first characters of one (as `list` prints them). */
async function resolveId(api: Api, id: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/.test(id)) return id;
  if (!/^[0-9a-f-]{4,35}$/.test(id)) throw usage(`"${id}" is not a deployment id`);
  const { deployments } = await api.get<{ deployments: Deployment[] }>("/deployments", { limit: 200 });
  const found = deployments.filter((d) => d.id.startsWith(id));
  if (found.length === 0) throw new CliError(`no deployment starting with ${id}`, EXIT.notFound, "see `freighter deployment list`");
  if (found.length > 1) throw usage(`${id} matches ${found.length} deployments; give more of it`);
  return found[0]!.id;
}

const deploymentShow = defineCommand({
  meta: { name: "show", description: "One deployment: what it did and how it ended" },
  args: { id: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const d = await api().get<Deployment>(`/deployments/${await resolveId(api(), args.id)}`);
      out.data(d, () => {
        out.facts([
          ["id", d.id],
          ["app", d.app],
          ["server", d.server],
          ["action", d.action],
          ["status", status(out, d)],
          ["release", d.releaseId ?? undefined],
          ["previous", d.previousRelease ?? undefined],
          ["commit", d.commitSha ? `${d.commitSha.slice(0, 12)} ${d.commitSubject ?? ""}`.trim() : undefined],
          ["started", d.startedAt ? ago(d.startedAt) : undefined],
          ["took", d.startedAt && d.finishedAt ? duration(Date.parse(d.finishedAt) - Date.parse(d.startedAt)) : undefined],
        ]);
        if (d.error) out.line(`\n${out.paint("red", d.error)}`);
        for (const w of d.warnings ?? []) out.warn(w);
      });
    }),
});

const deploymentLogs = defineCommand({
  meta: { name: "logs", description: "The log of a deployment" },
  args: { id: { type: "positional", required: true }, follow: { type: "boolean", alias: "f", description: "Follow one that is still running" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const id = await resolveId(api(), args.id);
      if (args.follow) {
        const d = await follow(api(), out, id, { verbose: true, sink: (l) => out.line(l) });
        if (d.status === "failed") throw new CliError(`deployment ${id.slice(0, 8)} failed`, EXIT.deployFailed);
        return;
      }
      let from = 0;
      for (;;) {
        const r = await api().get<{ text: string; next: number; done: boolean }>(`/deployments/${id}/log`, { from });
        if (r.text) process.stdout.write(r.text);
        from = r.next;
        if (r.done || !r.text) break;
      }
    }),
});

const deploymentCancel = defineCommand({
  meta: { name: "cancel", description: "Stop a deployment that is queued or running" },
  args: { id: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const id = await resolveId(api(), args.id);
      const r = await api().post<{ status?: string }>(`/deployments/${id}/cancel`);
      out.data({ id, ...r }, () => out.line(`Canceled ${id.slice(0, 8)}; the previous release keeps running.`));
    }),
});

export const deployment = defineCommand({
  meta: { name: "deployment", description: "Every deploy, rollback and config change" },
  subCommands: { list: deploymentList, show: deploymentShow, logs: deploymentLogs, cancel: deploymentCancel },
});

// ---- project ----

interface Project {
  id: string;
  name: string;
  description: string;
  appCount: number;
}

const projectList = defineCommand({
  meta: { name: "list", description: "The projects" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { projects } = await api().get<{ projects: Project[] }>("/projects");
      out.ids(projects.map((p) => p.name), projects, () => {
        if (projects.length === 0) return out.note("no projects: `freighter project create <name>` makes one");
        out.table(["PROJECT", "APPS", "DESCRIPTION"], projects.map((p) => [p.name, String(p.appCount), p.description]));
      });
    }),
});

const projectCreate = defineCommand({
  meta: { name: "create", description: "Make a project" },
  args: { name: { type: "positional", required: true }, description: { type: "string", description: "What it is for" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const p = await api().post<Project>("/projects", { name: args.name, description: args.description ?? "" });
      out.ids([p.name], p, () => out.line(`Created project ${p.name}.`));
    }),
});

const projectRename = defineCommand({
  meta: { name: "rename", description: "Rename a project" },
  args: { name: { type: "positional", required: true }, to: { type: "positional", required: true, description: "The new name" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const p = await projectByName(api(), args.name);
      const r = await api().patch<Project>(`/projects/${p.id}`, { name: args.to });
      out.data(r, () => out.line(`Renamed ${args.name} to ${args.to}.`));
    }),
});

const projectDelete = defineCommand({
  meta: { name: "delete", description: "Delete a project; its apps are kept" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const p = await projectByName(api(), args.name);
      await out.confirm(`Delete the project ${p.name}? Its ${p.appCount} app(s) are kept and move out of it.`);
      await api().delete(`/projects/${p.id}`);
      out.data({ deleted: p.name }, () => out.line(`Deleted project ${p.name}.`));
    }),
});

interface Graph {
  apps: { name: string; services: { name: string }[] }[];
  edges: { from: { app: string; service: string }; to: { app: string; service: string }; attr: string; key: string; broken: string | null }[];
}

const projectShow = defineCommand({
  meta: { name: "show", description: "A project's apps, and the connections between their services" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const p = await projectByName(api(), args.name);
      const g = await api().get<Graph>(`/projects/${p.id}/graph`);
      out.data({ ...p, graph: g }, () => {
        out.facts([["project", p.name], ["about", p.description]]);
        out.line();
        out.table(["APP", "SERVICES"], g.apps.map((a) => [a.name, a.services.map((s) => s.name).join(", ")]));
        if (g.edges.length) {
          out.line();
          out.table(["FROM", "TO", "VIA", ""], g.edges.map((e) => [`${e.from.app}/${e.from.service}`, `${e.to.app}/${e.to.service}.${e.attr}`, e.key, e.broken ? out.paint("red", e.broken) : ""]));
        }
      });
    }),
});

export const project = defineCommand({
  meta: { name: "project", description: "Group apps" },
  subCommands: { list: projectList, create: projectCreate, rename: projectRename, delete: projectDelete, show: projectShow },
});
