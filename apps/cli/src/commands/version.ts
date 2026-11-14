import { defineCommand } from "citty";
import { globalArgs, run } from "../lib/run.ts";

/** The version of this CLI. The control server serves the one that matches it. */
export const CLI_VERSION = "0.0.0";

interface ServerRow {
  name: string;
  kind: string;
  status: string;
  agentVersion: string | null;
}

export const version = defineCommand({
  meta: { name: "version", description: "Show the versions of this CLI, the control server and each agent" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api, connection }) => {
      const [control, servers] = await Promise.all([api().get<{ commit: string | null }>("/version"), api().get<{ servers: ServerRow[] }>("/servers")]);
      const short = (v: string | null | undefined) => (v ? v.slice(0, 7) : "unknown");
      const behind = (s: ServerRow) => s.kind === "remote" && !!s.agentVersion && !!control.commit && s.agentVersion !== control.commit;
      out.data({ cli: CLI_VERSION, server: control.commit, agents: Object.fromEntries(servers.servers.map((s) => [s.name, s.agentVersion])) }, () => {
        out.facts([
          ["cli", CLI_VERSION],
          ["server", `${short(control.commit)} (${new URL(connection().url).host})`],
          ["agents", servers.servers.map((s) => `${s.name} ${short(s.agentVersion)}${behind(s) ? " (behind: freighter server upgrade " + s.name + ")" : ""}`).join("\n        ")],
        ]);
      });
    }),
});
