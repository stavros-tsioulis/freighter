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
    name: { type: "string", required: true, description: "Label, e.g. ci-github" },
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

const list = defineCommand({
  meta: { name: "list", description: "List API tokens (never the secrets)" },
  args: { ...common },
  run: ({ args }) =>
    guard(async () => {
      const r = await registry(args.prefix);
      for (const t of r.tokens.list()) {
        console.log(`${t.id}  ${t.role.padEnd(8)}  ${t.name.padEnd(20)}  ${t.revokedAt ? "revoked" : `last used ${t.lastUsedAt ?? "never"}`}`);
      }
      r.close();
    }),
});

const revoke = defineCommand({
  meta: { name: "revoke", description: "Revoke an API token" },
  args: { id: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const r = await registry(args.prefix);
      const ok = r.tokens.revoke(args.id);
      r.close();
      if (!ok) throw new Error(`unknown or already revoked token "${args.id}"`);
      console.log(`revoked ${args.id}`);
    }),
});

export const token = defineCommand({
  meta: { name: "token", description: "Manage API tokens" },
  subCommands: { create, list, revoke },
});
