import { createInterface } from "node:readline/promises";
import { deleteApp } from "@freighter/core";
import { IDENT_RE } from "@freighter/manifest";
import { defineCommand } from "citty";
import { client, conn } from "../api.ts";
import { common, depsFrom, guard } from "../common.ts";

/** Typing the app's name is the confirmation: `--yes` stands in for scripts. */
async function confirmByName(name: string, yes: boolean | undefined, what: string): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error(`refusing to delete ${name} without asking: pass --yes to confirm in a script`);
  console.log(`This permanently deletes ${what}.\nThere is no undo.\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type the app's name (${name}) to confirm: `)).trim();
  rl.close();
  if (answer !== name) throw new Error("the name didn't match; nothing was deleted");
}

const del = defineCommand({
  meta: {
    name: "delete",
    description: "Delete an app for good: routing, services, certificates, releases, shared data and secrets",
  },
  args: {
    name: { type: "positional", required: true, description: "the app to delete" },
    yes: { type: "boolean", description: "Don't ask: for scripts" },
    local: { type: "boolean", description: "Delete from this server directly (run as root) instead of through the API; the dashboard's records are then left to the next sync, which shows the app as missing" },
    forget: { type: "boolean", description: "Through the API: only drop the dashboard's records, without contacting the app's server (for a server that is gone)" },
    ...conn,
    ...common,
  },
  run: ({ args }) =>
    guard(async () => {
      if (!IDENT_RE.test(args.name)) throw new Error(`invalid app name "${args.name}"`);
      if (args.local) {
        await confirmByName(args.name, args.yes, `${args.name} from this server: its services, routing, certificates, releases, shared data and secrets`);
        const r = await deleteApp(await depsFrom(args), args.name);
        console.log(`deleted ${r.app}: ${r.units.length} unit(s) removed${r.hostnames.length ? `, no longer routing ${r.hostnames.join(", ")}` : ""}`);
        return;
      }
      const call = client(args);
      await confirmByName(
        args.name,
        args.yes,
        args.forget ? `${args.name} from the dashboard's records only (its server is not contacted, so anything still on it stays)` : `${args.name} from its server and the dashboard: services, routing, certificates, releases, shared data and secrets`,
      );
      const r = await call<{ units: string[]; hostnames: string[]; server: string; forgotten: boolean }>(`/apps/${args.name}`, "DELETE", { confirm: args.name, ...(args.forget ? { forget: true } : {}) });
      console.log(
        r.forgotten
          ? `forgot ${args.name} (nothing was removed from ${r.server})`
          : `deleted ${args.name} from ${r.server}: ${r.units.length} unit(s) removed${r.hostnames.length ? `, no longer routing ${r.hostnames.join(", ")}` : ""}`,
      );
    }),
});

export const app = defineCommand({
  meta: { name: "app", description: "Manage apps" },
  subCommands: { delete: del },
});
