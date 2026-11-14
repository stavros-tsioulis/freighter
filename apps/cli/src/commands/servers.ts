import { defineCommand } from "citty";
import { apiCode, type Api } from "../lib/api.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { ago, bytes, duration, type Out } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";

interface Server {
  name: string;
  kind: "local" | "remote";
  address: string | null;
  status: string;
  agentVersion: string | null;
  hostname: string | null;
  host: { cpus?: number; os?: string; uptimeSeconds: number; load1: number; memTotal: number; memFree: number; diskFreeBytes: number | null; diskTotalBytes: number | null } | null;
  lastSeenAt: string | null;
  lastError: string | null;
  certExpiresAt: string | null;
  appCount: number;
}

const short = (v: string | null | undefined) => (v ? v.slice(0, 7) : "");
const gb = (n: number) => `${(n / 1e9).toFixed(1)}`;
const memory = (s: Server) => (s.host ? `${gb(s.host.memTotal - s.host.memFree)}/${gb(s.host.memTotal)} GB` : "");

const getServer = async (api: Api, name: string) => (await api.get<{ server?: Server } & Server>(`/servers/${name}`));

// ---- server ----

const list = defineCommand({
  meta: { name: "list", description: "The servers" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const [{ servers }, version] = await Promise.all([api().get<{ servers: Server[] }>("/servers"), api().get<{ commit: string | null }>("/version").catch(() => ({ commit: null }))]);
      out.ids(servers.map((s) => s.name), servers, () => {
        out.table(
          ["SERVER", "STATE", "AGENT", "LOAD", "MEMORY", "DISK FREE", "APPS"],
          servers.map((s) => [
            s.name,
            s.status === "online" ? s.status : out.paint(s.status === "pending" ? "yellow" : "red", s.status === "pending" ? "waiting to enroll" : s.status),
            `${short(s.agentVersion)}${s.kind === "remote" && s.agentVersion && version.commit && s.agentVersion !== version.commit ? out.paint("yellow", " (behind)") : ""}`,
            s.host ? s.host.load1.toFixed(1) : "",
            memory(s),
            s.host?.diskFreeBytes != null ? bytes(s.host.diskFreeBytes) : "",
            String(s.appCount),
          ]),
        );
      });
    }),
});

const show = defineCommand({
  meta: { name: "show", description: "One server" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const s = await getServer(api(), args.name);
      out.data(s, () =>
        out.facts([
          ["server", s.name],
          ["address", s.address ?? "(this machine)"],
          ["state", s.status],
          ["host", s.hostname ?? undefined],
          ["os", s.host?.os],
          ["agent", short(s.agentVersion) || undefined],
          ["uptime", s.host ? duration(s.host.uptimeSeconds * 1000) : undefined],
          ["load", s.host ? s.host.load1.toFixed(2) : undefined],
          ["memory", memory(s) || undefined],
          ["disk free", s.host?.diskFreeBytes != null ? `${bytes(s.host.diskFreeBytes)} of ${bytes(s.host.diskTotalBytes)}` : undefined],
          ["certificate", s.certExpiresAt ? `until ${s.certExpiresAt.slice(0, 10)}` : undefined],
          ["last seen", s.lastSeenAt ? ago(s.lastSeenAt) : undefined],
          ["last error", s.lastError ?? undefined],
          ["apps", String(s.appCount)],
        ]),
      );
    }),
});

interface Enrollment {
  server: Server;
  enrollment: { token: string; expiresAt: string | null; command: string };
}

const printEnrollment = (out: Out, e: Enrollment, intro: string) =>
  out.data(e, () => {
    out.line(intro);
    out.line(`\nOn ${e.server.name}, as root (the token works once, for an hour):\n\n  ${e.enrollment.command}\n  systemctl restart freighter-agent\n`);
  });

const add = defineCommand({
  meta: { name: "add", description: "Register a remote server and print the command that enrolls it" },
  args: { name: { type: "positional", required: true }, address: { type: "string", required: true, description: "The agent's host or host:port (port 7443 by default)" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => printEnrollment(out, await api().post<Enrollment>("/servers", { name: args.name, address: args.address }), `Added ${args.name}.`)),
});

const token = defineCommand({
  meta: { name: "token", description: "A new enrollment command, to re-enroll a server or renew its certificate" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => printEnrollment(out, await api().post<Enrollment>(`/servers/${args.name}/enrollment`), `A new enrollment for ${args.name}.`)),
});

const check = defineCommand({
  meta: { name: "check", description: "Contact the server now" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const s = await api().post<Server>(`/servers/${args.name}/check`);
      out.data(s, () => out.line(s.status === "online" ? `${s.name} is online (agent ${short(s.agentVersion)}).` : `${s.name} is ${s.status}${s.lastError ? `: ${s.lastError}` : ""}`));
      if (s.status !== "online" && s.status !== "pending") throw new CliError(`${s.name} is ${s.status}${s.lastError ? `: ${s.lastError}` : ""}`);
    }),
});

interface UpgradeView {
  supported: boolean;
  reason: string | null;
  commit: string | null;
  upgrade: { state: "running" | "verifying" | "rolling-back" | "done" | "rolled-back" | "failed"; from: string | null; to: string | null; message: string | null } | null;
  log: string;
}

const FEATURES = ["containers", "storage", "mounts", "archives", "firewall"] as const;

const upgrade = defineCommand({
  meta: { name: "upgrade", description: "Upgrade a server's agent, or add a feature to it" },
  args: {
    name: { type: "positional", required: true },
    ref: { type: "string", description: "A branch, tag or commit (default: the version this control server runs)" },
    with: { type: "string", description: `Add a feature at the installed version: ${FEATURES.join(", ")} (comma-separated)` },
    wait: { type: "boolean", default: true, description: "Follow it until it ends (--no-wait starts it and returns)" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const features = (args.with ?? "").split(",").map((f) => f.trim()).filter(Boolean);
      for (const f of features) if (!(FEATURES as readonly string[]).includes(f)) throw usage(`unknown feature "${f}"`, `one of ${FEATURES.join(", ")}`);
      if (features.length > 1) throw usage("one feature at a time", "run it again for the next");
      const body: Record<string, unknown> = { ...(args.ref ? { ref: args.ref } : {}), ...(features[0] ? { [features[0]]: true } : {}) };
      let view = await api().post<UpgradeView>(`/servers/${args.name}/upgrade`, body);
      out.step(features[0] ? `Adding ${features[0]} to ${args.name}` : `Upgrading ${args.name}`);
      if (!args.wait) return out.data(view, () => out.line(view.upgrade?.state ?? "started"));
      const every = Number(process.env.FREIGHTER_POLL_MS) || 2000;
      let last = "";
      for (;;) {
        const u = view.upgrade;
        if (u && u.message && u.message !== last) {
          out.step(u.message);
          last = u.message;
        }
        if (u && (u.state === "done" || u.state === "rolled-back" || u.state === "failed")) break;
        await new Promise((r) => setTimeout(r, every));
        view = await api().get<UpgradeView>(`/servers/${args.name}/upgrade`);
      }
      const u = view.upgrade!;
      out.data(view, () => undefined);
      if (u.state !== "done") throw new CliError(`the upgrade of ${args.name} ${u.state === "rolled-back" ? "was rolled back" : "failed"}${u.message ? `: ${u.message}` : ""}`, EXIT.deployFailed);
      out.note(`${args.name} is on ${short(u.to ?? view.commit)}`);
    }),
});

const restart = defineCommand({
  meta: { name: "restart", description: "Restart a server's agent" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      await api().post(`/servers/${args.name}/restart`, { service: "agent" });
      out.data({ server: args.name }, () => out.line(`Restarting the agent on ${args.name}.`));
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove a server that has no apps" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      await out.confirm(`Remove the server ${args.name}? It is forgotten here; nothing is removed from the machine.`);
      await api().delete(`/servers/${args.name}`);
      out.data({ removed: args.name }, () => out.line(`Removed ${args.name}.`));
    }),
});

interface Field {
  key: string;
  section: string;
  type: "string" | "number" | "boolean" | "list" | "enum";
  restart: string;
  value: unknown;
  default: unknown;
  explicit: boolean;
  options?: string[];
}

/** What was typed for a setting, as the type it has. */
export function fieldValue(f: Pick<Field, "key" | "type" | "options">, text: string): unknown {
  switch (f.type) {
    case "number": {
      const n = Number(text);
      if (text.trim() === "" || Number.isNaN(n)) throw usage(`${f.key} is a number`);
      return n;
    }
    case "boolean":
      if (!["true", "false", "yes", "no", "on", "off"].includes(text.toLowerCase())) throw usage(`${f.key} is true or false`);
      return ["true", "yes", "on"].includes(text.toLowerCase());
    case "list":
      return text.split(",").map((x) => x.trim()).filter(Boolean);
    case "enum":
      if (!f.options?.includes(text)) throw usage(`${f.key} is one of ${f.options?.join(", ")}`);
      return text;
    default:
      return text;
  }
}

const show_ = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));

const serverConfig = defineCommand({
  meta: { name: "config", description: "A server's config.yaml settings: show them, or set some" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const words = ((args as { _?: string[] })._ ?? []).slice(1);
      const { fields } = await api().get<{ fields: Field[] }>(`/servers/${args.name}/config`);
      if (words[0] !== "set") {
        return out.data({ fields }, () => out.table(["KEY", "VALUE", "DEFAULT"], fields.map((f) => [f.key, f.explicit ? show_(f.value) : out.paint("dim", show_(f.value)), f.explicit ? show_(f.default) : ""])));
      }
      const changes: Record<string, unknown> = {};
      for (const w of words.slice(1)) {
        const i = w.indexOf("=");
        if (i < 1) throw usage(`"${w}" is not key=value`);
        const key = w.slice(0, i);
        const f = fields.find((x) => x.key === key);
        if (!f) throw new CliError(`${args.name} has no setting "${key}"`, EXIT.notFound, `see \`freighter server config ${args.name}\``);
        changes[key] = fieldValue(f, w.slice(i + 1));
      }
      if (Object.keys(changes).length === 0) throw usage("give key=value");
      const r = await api().put<{ changed: string[]; restart: string[] }>(`/servers/${args.name}/config`, { changes });
      out.data(r, () => {
        out.line(`Changed ${r.changed.join(", ") || "nothing"}.`);
        if (r.restart.length) out.line(`Restart the ${r.restart.join(" and the ")} for it to take effect: freighter server restart ${args.name}`);
      });
    }),
});

export const server = defineCommand({
  meta: { name: "server", description: "The servers apps run on" },
  subCommands: { list, show, add, token, check, upgrade, restart, remove, config: serverConfig },
});

// ---- firewall ----

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

const strip = (s: string) => s.replace(/\s*\(v6\)$/, "");
const signature = (r: Rule) => [r.to, r.action, r.direction, r.from].map((x) => x.replace(/\s+/g, " ").trim()).join("|");
const v4Twin = (rule: Rule, rules: Rule[]) => (rule.v6 ? rules.find((r) => !r.v6 && r.action === rule.action && r.direction === rule.direction && r.comment === rule.comment && r.to === strip(rule.to) && r.from === strip(rule.from)) : undefined);
const hasV6Twin = (rule: Rule, rules: Rule[]) => !rule.v6 && rules.some((r) => v4Twin(r, rules)?.number === rule.number);

/** Run a firewall change; one the server says would lock you out is asked about, or done with `--yes`. */
async function guarded<T>(out: Out, run1: (acknowledged: boolean) => Promise<T>): Promise<T> {
  try {
    return await run1(false);
  } catch (e) {
    if (apiCode(e) !== "lockout") throw e;
    const reason = (e as Error).message.replace(/\s*Confirm to do it anyway\.$/, "");
    if (!out.yes) {
      if (!out.interactive) throw new CliError(reason, EXIT.failed, "pass --yes to do it anyway");
      await out.confirm(`${reason}\nDo it anyway?`);
    }
    return run1(true);
  }
}

function printFirewall(out: Out, fw: Firewall, server: string) {
  out.data(fw, () => {
    if (!fw.installed) return out.line(`The firewall isn't installed on ${server}: freighter server upgrade ${server} --with firewall`);
    out.line(fw.active ? `Firewall on (incoming: ${fw.defaults?.incoming}, outgoing: ${fw.defaults?.outgoing})` : "Firewall off");
    const rules = fw.rules.filter((r) => !v4Twin(r, fw.rules));
    if (fw.active && rules.length) out.table(["#", "ACTION", "TO", "FROM", "COMMENT"], rules.map((r) => [String(r.number), r.action, r.to, r.from, r.comment]));
  });
}

const fwStatus = async (api: Api, server: string) => api.get<Firewall>(`/servers/${server}/firewall`);

/** `5432`, `5432/tcp`, `8000:8100/udp`, `80,443/tcp`. */
function parsePort(spec: string): { port: string; proto: "tcp" | "udp" | "any" } {
  const [port, proto] = spec.split("/");
  if (proto !== undefined && proto !== "tcp" && proto !== "udp") throw usage(`"${spec}": the protocol is tcp or udp`);
  if (!port || !/^[\d:,]+$/.test(port)) throw usage(`"${spec}" is not a port`, "like 5432, 5432/tcp or 8000:8100/udp");
  return { port, proto: (proto as "tcp" | "udp" | undefined) ?? "any" };
}

const ACTIONS = ["allow", "deny", "reject", "limit"] as const;

export const firewall = defineCommand({
  meta: { name: "firewall", description: "A server's firewall (ufw): freighter firewall <server> [enable|disable|allow|deny|reject|limit|delete|default] ..." },
  args: {
    server: { type: "positional", required: true },
    verb: { type: "positional", required: false, description: "enable, disable, allow, deny, reject, limit, delete or default (none: show it)" },
    open: { type: "string", description: "With enable: more ports to keep open, comma-separated" },
    from: { type: "string", description: "With allow/deny/reject/limit: only from this address or network" },
    to: { type: "string", description: "Only to this address of the server" },
    comment: { type: "string", description: "What the rule is for" },
    position: { type: "string", description: "Insert at this rule number (the first rule that matches decides)" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const words = ((args as { _?: string[] })._ ?? []).slice(2);
      const verb = args.verb ?? "show";
      const base = `/servers/${args.server}/firewall`;

      if (verb === "show") return printFirewall(out, await fwStatus(api(), args.server), args.server);

      if (verb === "enable") {
        const open = (args.open ?? "").split(",").map((p) => p.trim()).filter(Boolean).map(Number);
        if (open.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw usage("--open takes port numbers from 1 to 65535");
        const fw = await api().post<Firewall>(`${base}/enable`, { open });
        return out.data(fw, () => out.line(`The firewall is on. Open: ${[...fw.essential.map((e) => e.port), ...open].join(", ")}.`));
      }

      if (verb === "disable") {
        await out.confirm(`Turn the firewall off on ${args.server}? Every port a service listens on becomes reachable.`);
        const fw = await api().post<Firewall>(`${base}/disable`);
        return out.data(fw, () => out.line("The firewall is off."));
      }

      if ((ACTIONS as readonly string[]).includes(verb)) {
        if (words.length !== 1) throw usage(`${verb} what?`, `freighter firewall ${args.server} ${verb} 5432/tcp [--from 10.0.0.0/8]`);
        const { port, proto } = parsePort(words[0]!);
        const position = args.position === undefined ? undefined : Number(args.position);
        if (position !== undefined && !Number.isInteger(position)) throw usage("--position is a rule number");
        const fw = await guarded(out, (acknowledged) =>
          api().post<Firewall>(`${base}/rules`, { action: verb, direction: "in", proto, port, ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}), ...(args.comment ? { comment: args.comment } : {}), ...(position ? { position } : {}), ...(acknowledged ? { acknowledged } : {}) }),
        );
        return out.data(fw, () => out.line(`Added: ${verb} ${words[0]}${args.from ? ` from ${args.from}` : ""}.`));
      }

      if (verb === "delete") {
        const number = Number(words[0]);
        if (!Number.isInteger(number)) throw usage("which rule?", `freighter firewall ${args.server} delete <number>`);
        const fw = await fwStatus(api(), args.server);
        const r = fw.rules.find((x) => x.number === number);
        if (!r) throw new CliError(`${args.server} has no rule ${number}`, EXIT.notFound, `see \`freighter firewall ${args.server}\``);
        const after = await guarded(out, (acknowledged) => api().post<Firewall>(`${base}/rules/delete`, { number, signature: signature(r), twin: hasV6Twin(r, fw.rules), ...(acknowledged ? { acknowledged } : {}) }));
        return out.data(after, () => out.line(`Removed rule ${number}: ${r.action} ${r.to}.`));
      }

      if (verb === "default") {
        const [direction, policy] = words;
        if (direction !== "incoming" && direction !== "outgoing") throw usage("the direction is incoming or outgoing", `freighter firewall ${args.server} default incoming deny`);
        if (!policy || !["allow", "deny", "reject"].includes(policy)) throw usage("the policy is allow, deny or reject");
        const fw = await guarded(out, (acknowledged) => api().put<Firewall>(`${base}/default`, { direction, policy, ...(acknowledged ? { acknowledged } : {}) }));
        return out.data(fw, () => out.line(`${direction[0]!.toUpperCase()}${direction.slice(1)} traffic with no rule: ${policy}.`));
      }

      throw usage(`unknown firewall command "${verb}"`, "enable, disable, allow, deny, reject, limit, delete or default");
    }),
});

// ---- process ----

interface Proc {
  pid: number;
  name: string;
  command: string;
  user: string;
  state: string;
  cpu: number;
  rss: number;
  startedMs: number;
  starttime: number;
  unit: string | null;
  managed: { kind: string; app?: string } | null;
}

const procList = defineCommand({
  meta: { name: "list", description: "What is running on a server" },
  args: { server: { type: "positional", required: true }, sort: { type: "string", description: "cpu or mem (default mem)", default: "mem" }, app: { type: "string", description: "Only this app's processes" }, all: { type: "boolean", description: "Include kernel threads" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (args.sort !== "cpu" && args.sort !== "mem") throw usage("--sort is cpu or mem");
      const r = await api().get<{ processes: Proc[]; memTotal: number }>(`/servers/${args.server}/processes`);
      let rows = r.processes.filter((p) => args.all || p.command !== "");
      if (args.app) rows = rows.filter((p) => p.managed?.app === args.app || p.unit?.startsWith(`freighter-${args.app}--`));
      rows.sort((a, b) => (args.sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss));
      out.ids(rows.map((p) => String(p.pid)), rows, () =>
        out.table(["PID", "USER", "CPU", "MEMORY", "NAME", "WHAT"], rows.slice(0, 60).map((p) => [String(p.pid), p.user, `${p.cpu.toFixed(1)}%`, bytes(p.rss), p.name, p.managed ? `${p.managed.kind}${p.managed.app ? ` ${p.managed.app}` : ""}` : ""])),
      );
    }),
});

const procSignal = defineCommand({
  meta: { name: "signal", description: "Send a signal to a process" },
  args: { server: { type: "positional", required: true }, pid: { type: "positional", required: true }, signal: { type: "positional", required: true, description: "TERM, KILL, HUP, INT, STOP or CONT" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const pid = Number(args.pid);
      const signal = args.signal.toUpperCase().replace(/^SIG/, "");
      if (!Number.isInteger(pid) || pid < 1) throw usage("the pid is a number");
      if (!["TERM", "KILL", "HUP", "INT", "STOP", "CONT"].includes(signal)) throw usage("the signal is TERM, KILL, HUP, INT, STOP or CONT");
      const { processes } = await api().get<{ processes: Proc[] }>(`/servers/${args.server}/processes`);
      const p = processes.find((x) => x.pid === pid);
      if (!p) throw new CliError(`${args.server} has no process ${pid}`, EXIT.notFound);
      if (signal === "KILL" || signal === "TERM") await out.confirm(`Send ${signal} to ${p.name} (${pid}) on ${args.server}?`);
      await api().post(`/servers/${args.server}/processes/signal`, { pid, starttime: p.starttime, signal });
      out.data({ pid, signal }, () => out.line(`Sent ${signal} to ${p.name} (${pid}).`));
    }),
});

export const process_ = defineCommand({
  meta: { name: "process", description: "A server's processes" },
  subCommands: { list: procList, signal: procSignal },
});

// ---- settings ----

const settingsSet = defineCommand({
  meta: { name: "set", description: "Change settings: key=value ..." },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const words = (args as { _?: string[] })._ ?? [];
      const { fields } = await api().get<{ fields: Field[] }>("/settings");
      const changes: Record<string, unknown> = {};
      for (const w of words) {
        const i = w.indexOf("=");
        if (i < 1) throw usage(`"${w}" is not key=value`);
        const key = w.slice(0, i);
        const f = fields.find((x) => x.key === key);
        if (!f) throw new CliError(`no setting "${key}"`, EXIT.notFound, "see `freighter settings`");
        changes[key] = fieldValue(f, w.slice(i + 1));
      }
      if (Object.keys(changes).length === 0) throw usage("give key=value");
      const r = await api().put<{ changed?: string[] }>("/settings", { changes });
      out.data(r, () => out.line(`Changed ${Object.keys(changes).join(", ")}.`));
    }),
});

export const settings = defineCommand({
  meta: { name: "settings", description: "The control server's own settings" },
  args: { ...globalArgs },
  subCommands: { set: settingsSet },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { fields } = await api().get<{ fields: Field[] }>("/settings");
      out.data({ fields }, () => out.table(["KEY", "VALUE", "DEFAULT"], fields.map((f) => [f.key, show_(f.value), f.explicit ? show_(f.default) : ""])));
    }),
});

