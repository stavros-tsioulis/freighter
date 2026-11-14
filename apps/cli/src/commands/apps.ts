import { defineCommand } from "citty";
import type { Api } from "../lib/api.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { ago, bytes, type Out } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";
import { target } from "../lib/target.ts";
import { parseSpan } from "../lib/wait.ts";

export interface Service {
  name: string;
  unit: string;
  port: number | null;
  hostnames: string[];
  activeState: string;
  subState: string;
  restarts: number;
  memoryBytes: number | null;
}

export interface AppRow {
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

/** What a person reads for a unit's state: `activating` with `auto-restart` is a crash that is being started again. */
export function stateOf(s: Pick<Service, "activeState" | "subState">): string {
  if (s.activeState === "activating" && s.subState === "auto-restart") return "retrying";
  if (s.activeState === "active") return "running";
  if (s.activeState === "inactive") return "stopped";
  return s.activeState;
}

const colorState = (out: Out, state: string) => (state === "running" ? state : state === "retrying" || state === "failed" ? out.paint("red", state) : out.paint("yellow", state));

const projects = async (api: Api) => (await api.get<{ projects: Project[] }>("/projects")).projects;

/** A project by name (or id). */
export async function projectByName(api: Api, name: string): Promise<Project> {
  const p = (await projects(api)).find((x) => x.name === name || x.id === name);
  if (!p) throw new CliError(`no project named "${name}"`, EXIT.notFound, "see `freighter project list`");
  return p;
}

const domainOf = (a: { services: Service[] }) => a.services.flatMap((s) => s.hostnames)[0] ?? "";
const running = (a: { services: Service[] }) => `${a.services.filter((s) => s.activeState === "active").length}/${a.services.length}`;

const list = defineCommand({
  meta: { name: "list", description: "List the apps" },
  args: { project: { type: "string", description: "Only this project's apps" }, server: { type: "string", description: "Only this server's apps" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { apps } = await api().get<{ apps: AppRow[] }>("/apps");
      const projectId = args.project ? (await projectByName(api(), args.project)).id : undefined;
      const shown = apps.filter((a) => a.kind !== "storage" && (!projectId || a.projectId === projectId) && (!args.server || a.server === args.server));
      out.ids(shown.map((a) => a.name), shown.map((a) => ({ name: a.name, server: a.server, state: a.status, release: a.currentRelease, services: a.services.length, domain: domainOf(a) || null })), () => {
        if (shown.length === 0) return out.note("no apps yet: `freighter deploy` makes one");
        out.table(["APP", "SERVER", "STATE", "SERVICES", "RELEASE", "DOMAIN"], shown.map((a) => [a.name, a.server, a.status, running(a), a.currentRelease ?? "", domainOf(a)]));
      });
    }),
});

const show = defineCommand({
  meta: { name: "show", description: "Everything about one app" },
  args: { app: { type: "positional", required: false, description: "The app (default: the one in this directory)" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const a = await api().get<AppRow>(`/apps/${app}`);
      const project = a.projectId ? (await projects(api())).find((p) => p.id === a.projectId)?.name : undefined;
      out.data(a, () => {
        out.facts([
          ["app", a.name],
          ["server", a.server],
          ["state", a.status],
          ["release", a.currentRelease ?? undefined],
          ["previous", a.previousRelease ?? undefined],
          ["project", project],
          ["synced", a.syncedAt ? ago(a.syncedAt) : undefined],
        ]);
        out.line();
        psTable(out, a.services);
        const latest = a.deployments?.[0];
        if (latest) out.note(`\nlatest deployment: ${latest.action} ${latest.status} ${ago(latest.createdAt)} (${latest.id.slice(0, 8)})`);
      });
    }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete an app for good: services, routing, certificates, releases, data and secrets" },
  args: {
    app: { type: "positional", required: true, description: "The app to delete" },
    forget: { type: "boolean", description: "Only drop the dashboard's records, without contacting the app's server (for a server that is gone)" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      await out.confirm(
        args.forget ? `This forgets ${app} in the dashboard only; its server is not contacted, so anything still on it stays.\nThere is no undo.` : `This permanently deletes ${app} from its server and the dashboard: services, routing, certificates, releases, shared data and secrets.\nThere is no undo.`,
        { typed: app, verb: "delete" },
      );
      const r = await api().delete<{ units: string[]; hostnames: string[]; server: string; forgotten: boolean }>(`/apps/${app}`, { confirm: app, ...(args.forget ? { forget: true } : {}) });
      out.data(r, () => out.line(r.forgotten ? `Forgot ${app} (nothing was removed from ${r.server}).` : `Deleted ${app} from ${r.server}: ${r.units.length} unit(s) removed${r.hostnames.length ? `, no longer routing ${r.hostnames.join(", ")}` : ""}.`));
    }),
});

const move = defineCommand({
  meta: { name: "move", description: "Put an app in a project (or `none`)" },
  args: { app: { type: "positional", required: true }, project: { type: "string", required: true, description: "The project, or none" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const projectId = args.project === "none" ? null : (await projectByName(api(), args.project)).id;
      await api().put(`/apps/${app}/project`, { projectId });
      out.data({ app, project: projectId ? args.project : null }, () => out.line(projectId ? `Moved ${app} to ${args.project}.` : `Took ${app} out of its project.`));
    }),
});

export const app = defineCommand({
  meta: { name: "app", description: "List, show, delete and organize apps" },
  subCommands: { list, show, delete: del, move },
});

// ---- services ----

function psTable(out: Out, services: Service[], cpu: Record<string, number | null> = {}, withApp?: string[]): void {
  if (services.length === 0) return out.note("no services yet");
  out.table(
    [...(withApp ? ["APP"] : []), "SERVICE", "STATE", "RESTARTS", "MEMORY", "CPU", "ADDRESS"],
    services.map((s, i) => [...(withApp ? [withApp[i]!] : []), s.name, colorState(out, stateOf(s)), String(s.restarts), bytes(s.memoryBytes), cpu[s.name] == null ? "" : `${Math.round(cpu[s.name]!)}%`, s.hostnames[0] ?? ""]),
  );
}

interface Sample {
  at: string;
  memoryBytes: number | null;
  cpuPercent: number | null;
  restarts: number;
}

export const ps = defineCommand({
  meta: { name: "ps", description: "The services of an app, and what they are doing" },
  args: { app: { type: "positional", required: false, description: "The app (default: the one in this directory; none shown means every app)" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      let name: string | undefined;
      try {
        name = target(args.app).app;
      } catch (e) {
        if (args.app !== undefined) throw e;
      }
      if (!name) {
        const { apps } = await api().get<{ apps: AppRow[] }>("/apps");
        const rows = apps.filter((a) => a.kind !== "storage").flatMap((a) => a.services.map((s) => ({ app: a.name, ...s })));
        return out.ids(rows.map((r) => `${r.app}/${r.name}`), rows, () =>
          psTable(out, rows, {}, rows.map((r) => r.app)),
        );
      }
      const a = await api().get<AppRow>(`/apps/${name}`);
      const cpu: Record<string, number | null> = {};
      try {
        const { series } = await api().get<{ series: Record<string, Sample[]> }>(`/apps/${name}/metrics`, { minutes: 5 });
        for (const [svc, samples] of Object.entries(series)) cpu[svc] = samples.at(-1)?.cpuPercent ?? null;
      } catch {
        /* no samples yet */
      }
      out.ids(a.services.map((s) => `${name}/${s.name}`), a.services.map((s) => ({ ...s, state: stateOf(s), cpuPercent: cpu[s.name] ?? null })), () => psTable(out, a.services, cpu));
    }),
});

const control = (verb: "start" | "stop" | "restart", ask: boolean) =>
  defineCommand({
    meta: { name: verb, description: `${verb[0]!.toUpperCase()}${verb.slice(1)} an app's services, or one service` },
    args: { target: { type: "positional", required: false, description: "app or app/service (default: the app in this directory)" }, ...globalArgs },
    run: ({ args }) =>
      run(args, async ({ out, api }) => {
        const t = target(args.target);
        if (ask) await out.confirm(`Stop ${t.service ? `${t.app}/${t.service}` : t.app}? It stops serving until it is started again.`);
        const r = await api().post<{ units: string[] }>(`/apps/${t.app}/${verb}`, t.service ? { service: t.service } : {});
        out.data({ app: t.app, service: t.service ?? null, units: r.units }, () => out.line(`${verb === "stop" ? "Stopped" : verb === "start" ? "Started" : "Restarted"} ${t.service ? `${t.app}/${t.service}` : t.app} (${r.units.length} service${r.units.length === 1 ? "" : "s"}).`));
      }),
  });
export const start = control("start", false);
export const stop = control("stop", true);
export const restart = control("restart", false);

export const logs = defineCommand({
  meta: { name: "logs", description: "A service's log, from the journal" },
  args: {
    target: { type: "positional", required: false, description: "app or app/service (without a service, all of the app's)" },
    n: { type: "string", alias: "n", description: "How many lines (up to 1000)", default: "100" },
    follow: { type: "boolean", alias: "f", description: "Keep following" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const t = target(args.target);
      const lines = Number(args.n);
      if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw usage("-n is a number of lines from 1 to 1000");
      const services = t.service ? [t.service] : (await api().get<AppRow>(`/apps/${t.app}`)).services.map((s) => s.name);
      if (services.length === 0) throw new CliError(`${t.app} has no services yet`, EXIT.notFound);
      const prefix = (s: string, line: string) => (services.length > 1 ? `${out.paint("dim", s.padEnd(Math.max(...services.map((x) => x.length))))}  ${line}` : line);
      const last = new Map<string, string>();
      const fetch = async (s: string, n: number) => (await api().get<{ text: string }>(`/apps/${t.app}/logs`, { service: s, lines: n })).text.split("\n").filter((l) => l !== "");
      const printNew = async (s: string, n: number) => {
        const got = await fetch(s, n);
        const seen = last.get(s);
        const at = seen === undefined ? -1 : got.lastIndexOf(seen);
        const fresh = at === -1 ? got : got.slice(at + 1);
        for (const l of fresh) out.line(prefix(s, l));
        if (got.length) last.set(s, got.at(-1)!);
      };
      for (const s of services) await printNew(s, lines);
      if (!args.follow) return;
      const every = Number(process.env.FREIGHTER_POLL_MS) || 2000;
      for (;;) {
        await new Promise((r) => setTimeout(r, every));
        for (const s of services) await printNew(s, 200);
      }
    }),
});

export const stats = defineCommand({
  meta: { name: "stats", description: "Memory, CPU and restarts of an app's services" },
  args: { app: { type: "positional", required: false }, since: { type: "string", description: "How far back to look (default 1h)", default: "1h" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const minutes = Math.max(1, Math.round(parseSpan(args.since) / 60_000));
      const r = await api().get<{ minutes: number; series: Record<string, Sample[]> }>(`/apps/${app}/metrics`, { minutes });
      out.data(r, () => {
        const rows = Object.entries(r.series).map(([svc, s]) => {
          const mem = s.map((x) => x.memoryBytes ?? 0);
          const cpu = s.map((x) => x.cpuPercent ?? 0);
          const last = s.at(-1);
          return [svc, bytes(last?.memoryBytes ?? null), bytes(mem.length ? Math.max(...mem) : null), last?.cpuPercent == null ? "" : `${Math.round(last.cpuPercent)}%`, cpu.length ? `${Math.round(Math.max(...cpu))}%` : "", String(last?.restarts ?? 0)];
        });
        if (rows.length === 0) return out.note(`no samples in the last ${args.since}`);
        out.table(["SERVICE", "MEMORY", "PEAK", "CPU", "PEAK", "RESTARTS"], rows);
      });
    }),
});
