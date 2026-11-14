import { defineCommand } from "citty";
import { CLI_VERSION } from "../lib/cli.ts";

export const version = defineCommand({
  meta: { name: "version", description: "Print the freighter-agent version" },
  run: () => {
    console.log(CLI_VERSION);
  },
});
