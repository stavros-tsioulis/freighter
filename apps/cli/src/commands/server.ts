import { checkServer, createAgentDirectory, parseAddress, type ApiContext } from "@freighter/api";
import { loadConfig } from "@freighter/core/config";
import { IDENT_RE } from "@freighter/manifest";
import { PkiStore, fingerprint } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";
import { defineCommand } from "citty";
import { common, guard } from "../common.ts";

async function open(prefix?: string) {
  const config = await loadConfig(prefix);
  const registry = openRegistry(config.registry.path);
  const pki = new PkiStore(config.pki.dir);
  return { config, registry, pki };
}

const control = { control: { type: "string", description: "Public URL of this control plane (or $FREIGHTER_URL), shown in the enroll command" } } as const;

async function printEnrollment(o: Awaited<ReturnType<typeof open>>, name: string, token: string, controlUrl?: string) {
  const fp = fingerprint((await o.pki.ensureCa()).certPem);
  const url = (controlUrl ?? process.env.FREIGHTER_URL ?? "https://<control-plane-url>").replace(/\/+$/, "");
  console.log(`\nOn ${name}, as root (token valid for 1 hour, single use):\n\n  freighter-agent enroll --control ${url} --token ${token} --ca-fingerprint ${fp}\n  systemctl restart freighter-agent\n`);
}

const add = defineCommand({
  meta: { name: "add", description: "Register a remote server and print its one-time enrollment command" },
  args: { name: { type: "positional", required: true }, address: { type: "string", required: true, description: "host or host:port of the agent (default port 7443)" }, ...control, ...common },
  run: ({ args }) =>
    guard(async () => {
      if (!IDENT_RE.test(args.name) || args.name === "local") throw new Error(`invalid server name "${args.name}"`);
      parseAddress(args.address);
      const o = await open(args.prefix);
      if (o.registry.servers.get(args.name)) throw new Error(`server "${args.name}" already exists`);
      o.registry.servers.create({ name: args.name, address: args.address });
      await printEnrollment(o, args.name, o.registry.servers.newEnrollment(args.name), args.control);
      o.registry.close();
    }),
});

const token = defineCommand({
  meta: { name: "token", description: "Issue a new enrollment token (to re-enroll or renew a server's certificate)" },
  args: { name: { type: "positional", required: true }, ...control, ...common },
  run: ({ args }) =>
    guard(async () => {
      const o = await open(args.prefix);
      if (!o.registry.servers.get(args.name)) throw new Error(`unknown server "${args.name}"`);
      await printEnrollment(o, args.name, o.registry.servers.newEnrollment(args.name), args.control);
      o.registry.close();
    }),
});

const list = defineCommand({
  meta: { name: "list", description: "List servers" },
  args: { ...common },
  run: ({ args }) =>
    guard(async () => {
      const o = await open(args.prefix);
      for (const s of o.registry.servers.list()) {
        const expiry = s.certExpiresAt ? `cert until ${s.certExpiresAt.slice(0, 10)}` : "";
        console.log(`${s.name.padEnd(16)} ${s.status.padEnd(8)} ${(s.address ?? "(this host)").padEnd(28)} apps ${s.appCount}  ${expiry}${s.lastError ? `  ! ${s.lastError}` : ""}`);
      }
      o.registry.close();
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove a remote server (it must have no apps)" },
  args: { name: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const o = await open(args.prefix);
      const s = o.registry.servers.get(args.name);
      if (!s) throw new Error(`unknown server "${args.name}"`);
      if (s.kind === "local") throw new Error("the local server cannot be removed");
      if (s.appCount > 0) throw new Error(`server "${args.name}" still has ${s.appCount} app(s)`);
      o.registry.servers.remove(args.name);
      console.log(`removed ${args.name}`);
      o.registry.close();
    }),
});

const check = defineCommand({
  meta: { name: "check", description: "Contact a server's agent now and record its status" },
  args: { name: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const o = await open(args.prefix);
      if (!o.registry.servers.get(args.name)) throw new Error(`unknown server "${args.name}"`);
      const agents = await createAgentDirectory({ registry: o.registry, localSocket: o.config.agent.socket, pki: o.pki, timeoutMs: 10_000 });
      const s = await checkServer({ registry: o.registry, agents } as ApiContext, args.name);
      console.log(`${s?.name}: ${s?.status}${s?.lastError ? ` (${s.lastError})` : ""}${s?.host ? `  load ${s.host.load1.toFixed(2)}  mem free ${Math.round(s.host.memFree / 1048576)} MiB` : ""}`);
      o.registry.close();
      if (s?.status !== "online") process.exitCode = 1;
    }),
});

export const server = defineCommand({
  meta: { name: "server", description: "Manage remote servers (run as the user that owns the registry)" },
  subCommands: { add, list, token, remove, check },
});
