import { loadConfig } from "@freighter/core/config";
import { isRole, openRegistry } from "@freighter/registry";
import { defineCommand } from "citty";
import { common, guard } from "../common.ts";

async function registry(prefix?: string) {
  return openRegistry((await loadConfig(prefix)).registry.path);
}

const create = defineCommand({
  meta: { name: "create", description: "Create an API token (shown once). Run as the user that owns the registry DB." },
  args: {
    name: { type: "positional", required: true, description: "Label, e.g. ci-github" },
    role: { type: "string", default: "viewer", description: "viewer | deployer | admin" },
    ...common,
  },
  run: ({ args }) =>
    guard(async () => {
      if (!isRole(args.role)) throw new Error(`invalid role "${args.role}" (viewer | deployer | admin)`);
      const r = await registry(args.prefix);
      const { token, row } = r.tokens.create({ name: args.name, role: args.role });
      r.close();
      console.log(`${row.id}  ${row.role}  ${row.name}\n\n${token}\n\nStore this token now; it cannot be shown again.`);
    }),
});

export const token = defineCommand({
  meta: { name: "token", description: "Manage API tokens" },
  subCommands: { create },
});
