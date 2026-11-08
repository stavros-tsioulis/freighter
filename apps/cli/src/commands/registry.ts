import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { client, conn } from "../api.ts";
import { guard } from "../common.ts";
import { waitForDeployment } from "./push.ts";

interface Login { host: string; username: string; updatedAt: string }

const add = defineCommand({
  meta: { name: "add", description: "Save a login for a container registry (used when pulling images). Stored encrypted." },
  args: {
    host: { type: "positional", required: true, description: "registry host, e.g. ghcr.io (Docker Hub is docker.io)" },
    username: { type: "string", required: true, description: "registry user name" },
    "password-stdin": { type: "boolean", description: "read the password or access token from stdin (recommended)" },
    password: { type: "string", description: "password or token (or $FREIGHTER_REGISTRY_PASSWORD); avoid: it ends up in your shell history" },
    ...conn,
  },
  run: ({ args }) =>
    guard(async () => {
      const password = args["password-stdin"] ? readFileSync(0, "utf8").trim() : (args.password ?? process.env.FREIGHTER_REGISTRY_PASSWORD);
      if (!password) throw new Error("no password: use --password-stdin, --password or $FREIGHTER_REGISTRY_PASSWORD");
      const r = await client(args)<Login>(`/registries/${encodeURIComponent(args.host)}`, "PUT", { username: args.username, password });
      console.log(`saved the login for ${r.host} (user ${r.username})`);
    }),
});

const list = defineCommand({
  meta: { name: "list", description: "List the registries Freighter has a login for" },
  args: { ...conn },
  run: ({ args }) =>
    guard(async () => {
      const { registries } = await client(args)<{ registries: Login[] }>("/registries");
      if (registries.length === 0) console.log("no registry logins (public images need none)");
      for (const r of registries) console.log(`${r.host}  ${r.username}  updated ${r.updatedAt}`);
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Delete the login for a registry" },
  args: { host: { type: "positional", required: true, description: "registry host" }, ...conn },
  run: ({ args }) =>
    guard(async () => {
      await client(args)(`/registries/${encodeURIComponent(args.host)}`, "DELETE");
      console.log(`removed the login for ${args.host}`);
    }),
});

export const registry = defineCommand({
  meta: { name: "registry", description: "Manage logins for the container registries your images are pulled from" },
  subCommands: { add, list, remove },
});

export const redeploy = defineCommand({
  meta: { name: "redeploy", description: "Pull an image app's images again and release the result (e.g. after pushing a new :latest)" },
  args: {
    app: { type: "positional", required: true, description: "app name" },
    wait: { type: "boolean", default: true, description: "Wait for the deployment to finish (--no-wait to return immediately)" },
    ...conn,
  },
  run: ({ args }) =>
    guard(async () => {
      const call = client(args);
      const { id } = await call<{ id: string }>(`/apps/${args.app}/redeploy`, "POST");
      console.log(`queued deployment ${id} for ${args.app}`);
      if (args.wait) {
        const base = (args.url ?? process.env.FREIGHTER_URL ?? "").replace(/\/+$/, "");
        await waitForDeployment(base, (args.token ?? process.env.FREIGHTER_TOKEN)!, id, args.app);
      }
    }),
});
