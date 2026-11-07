import { spawn } from "node:child_process";
import { appStatus, controlApp, listEnvNames, listReleases, resolveServiceUnit, rollback as runRollback, setEnv } from "@freighter/core";
import { defineCommand } from "citty";
import { common, depsFrom, guard } from "../common.ts";

export const releases = defineCommand({
  meta: { name: "releases", description: "List releases of an app" },
  args: { app: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const list = await listReleases(await depsFrom(args), args.app);
      if (list.length === 0) throw new Error(`app "${args.app}" has no releases`);
      for (const r of list.reverse()) {
        console.log(`${r.current ? "*" : " "} ${r.id}  ${(r.result ?? "-").padEnd(7)}  ${r.at ?? ""}`);
      }
    }),
});

export const rollback = defineCommand({
  meta: { name: "rollback", description: "Roll back to the previous (or a given) release" },
  args: {
    app: { type: "positional", required: true },
    release: { type: "positional", required: false, description: "Release id (default: previous good)" },
    verify: { type: "boolean", default: true, description: "Health-check after rolling back" },
    ...common,
  },
  run: ({ args }) =>
    guard(async () => {
      const r = await runRollback(await depsFrom(args), args.app, {
        target: args.release,
        skipVerify: !args.verify || Boolean(args.prefix),
      });
      console.log(`rolled back ${r.app}: ${r.from} -> ${r.to}${r.verified ? " (healthy)" : ""}`);
    }),
});

export const status = defineCommand({
  meta: { name: "status", description: "Show the current release and service states" },
  args: { app: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const s = await appStatus(await depsFrom(args), args.app);
      console.log(`${s.app}  release ${s.release ?? "-"}  previous ${s.previous ?? "-"}`);
      for (const [name, u] of Object.entries(s.services)) {
        const mem = u.memoryCurrent === null ? "-" : `${Math.round(u.memoryCurrent / 1024 / 1024)}M`;
        const where = [u.port !== undefined ? `:${u.port}` : "", ...u.hostnames].filter(Boolean).join(" ");
        console.log(`  ${name.padEnd(12)} ${u.activeState}/${u.subState}  pid ${u.mainPid}  mem ${mem}  restarts ${u.restarts}  ${where}`);
      }
    }),
});

export const logs = defineCommand({
  meta: { name: "logs", description: "Show service logs (journalctl)" },
  args: {
    app: { type: "positional", required: true },
    service: { type: "positional", required: true },
    lines: { type: "string", alias: "n", default: "100" },
    follow: { type: "boolean", alias: "F", description: "Follow the log" },
    ...common,
  },
  run: ({ args }) =>
    guard(async () => {
      const d = await depsFrom(args);
      const jargs = d.systemd.logsArgs(await resolveServiceUnit(d, args.app, args.service), {
        lines: Number(args.lines),
        follow: args.follow,
      });
      await new Promise<void>((resolve, reject) => {
        const p = spawn("journalctl", jargs, { stdio: "inherit" });
        p.on("error", reject);
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`journalctl exited with code ${code}`))));
      });
    }),
});

function control(verb: "start" | "stop" | "restart") {
  return defineCommand({
    meta: { name: verb, description: `${verb[0]!.toUpperCase()}${verb.slice(1)} all services of an app, or one` },
    args: { app: { type: "positional", required: true }, service: { type: "positional", required: false }, ...common },
    run: ({ args }) =>
      guard(async () => {
        const units = await controlApp(await depsFrom(args), args.app, verb, args.service);
        for (const u of units) console.log(`${verb}: ${u}`);
      }),
  });
}
export const start = control("start");
export const stop = control("stop");
export const restart = control("restart");

async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.replace(/\r?\n$/, "");
}

const envSet = defineCommand({
  meta: { name: "set", description: "Set a secret: KEY=VALUE, or KEY with the value on stdin" },
  args: { app: { type: "positional", required: true }, pair: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const i = args.pair.indexOf("=");
      const key = i === -1 ? args.pair : args.pair.slice(0, i);
      const value = i === -1 ? await readStdin() : args.pair.slice(i + 1);
      await setEnv(await depsFrom(args), args.app, key, value);
      console.log(`set ${key} for ${args.app}`);
    }),
});

const envList = defineCommand({
  meta: { name: "list", description: "List secret names (never values)" },
  args: { app: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      for (const n of await listEnvNames(await depsFrom(args), args.app)) console.log(n);
    }),
});

export const env = defineCommand({
  meta: { name: "env", description: "Manage an app's secrets file" },
  subCommands: { set: envSet, list: envList },
});
