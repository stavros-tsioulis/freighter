import { defineCommand } from "citty";
import { client, conn, keyId } from "../api.ts";
import { guard } from "../common.ts";

interface Link {
  repository: string; branch: string; subpath: string; provider: string; autoDeploy: boolean;
  publicKey: string; keyFingerprint: string; sshKey?: { name: string; fingerprint: string } | null; webhookUrl: string; lastDeliveryAt: string | null; lastDeliveryResult: string | null;
}

const show = (l: Link) =>
  console.log(
    [
      `repository   ${l.repository}`,
      `branch       ${l.branch}${l.subpath ? `  (subdirectory ${l.subpath})` : ""}`,
      `git host     ${l.provider}`,
      `ssh key      ${l.sshKey ? `${l.sshKey.name} (${l.sshKey.fingerprint})` : "generated deploy key"}`,
      `auto-deploy  ${l.autoDeploy ? "on" : "off"}`,
      `last webhook ${l.lastDeliveryAt ? `${l.lastDeliveryAt}  ${l.lastDeliveryResult}` : "none"}`,
    ].join("\n"),
  );

const link = defineCommand({
  meta: { name: "link", description: "Link an app to a Git repository and print the deploy key and webhook to add" },
  args: {
    app: { type: "positional", required: true },
    repo: { type: "string", required: true, description: "git@host:org/repo.git or https://…" },
    branch: { type: "string", default: "main" },
    provider: { type: "string", default: "github", description: "github | gitlab | other" },
    subpath: { type: "string", default: "", description: "subdirectory of a monorepo" },
    "no-auto": { type: "boolean", description: "do not deploy automatically on push" },
    server: { type: "string", description: "server for a new app (apps are pinned to their first server)" },
    key: { type: "string", description: "name of an imported SSH key (see `freighter ssh-key import`); default: generate a deploy key for the app" },
    ...conn,
  },
  run: ({ args }) =>
    guard(async () => {
      const call = client(args);
      const sshKeyId = args.key ? await keyId(call, args.key) : null;
      const r = await call<{ link: Link; webhookSecret?: string }>(`/apps/${args.app}/git`, "PUT", {
        repository: args.repo, branch: args.branch, provider: args.provider, subpath: args.subpath,
        autoDeploy: !args["no-auto"], sshKeyId, ...(args.server ? { server: args.server } : {}),
      });
      show(r.link);
      if (!sshKeyId) console.log(`\n1. Add this deploy key (read-only) to the repository:\n\n   ${r.link.publicKey}\n`);
      console.log(`${sshKeyId ? "" : "2. "}Add a webhook for push events (optional, for automatic deploys):\n   URL    ${r.link.webhookUrl}\n   Secret ${r.webhookSecret ?? "(unchanged; use \`freighter git rotate-secret\` for a new one)"}\n   Type   application/json (GitHub) / secret token (GitLab)\n`);
      if (r.webhookSecret) console.log("The secret is shown once.");
    }),
});

const add = defineCommand({
  meta: { name: "add", description: "Create an app from a repository: reads app.yaml for the name, links it and deploys" },
  args: {
    repo: { type: "positional", required: true, description: "git@host:org/repo.git" },
    branch: { type: "string", default: "main" },
    key: { type: "string", description: "name of an imported SSH key" },
    subpath: { type: "string", default: "" },
    server: { type: "string" },
    "no-auto": { type: "boolean", description: "do not deploy automatically on push" },
    ...conn,
  },
  run: ({ args }) =>
    guard(async () => {
      const call = client(args);
      const sshKeyId = args.key ? await keyId(call, args.key) : null;
      const r = await call<{ app: string; deployment: { id: string }; link: Link; webhookSecret: string }>("/git/deployments", "POST", {
        repository: args.repo, branch: args.branch, subpath: args.subpath, sshKeyId, autoDeploy: !args["no-auto"], ...(args.server ? { server: args.server } : {}),
      });
      console.log(`app "${r.app}" linked; deployment ${r.deployment.id} queued`);
      console.log(`webhook: ${r.link.webhookUrl}\nsecret:  ${r.webhookSecret} (shown once)`);
      if (!sshKeyId) console.log(`deploy key to add to the repository:\n  ${r.link.publicKey}`);
    }),
});

const showCmd = defineCommand({
  meta: { name: "show", description: "Show an app's repository link" },
  args: { app: { type: "positional", required: true }, ...conn },
  run: ({ args }) => guard(async () => show(await client(args)<Link>(`/apps/${args.app}/git`))),
});

const check = defineCommand({
  meta: { name: "check", description: "Test that the server can reach the repository with its SSH key" },
  args: { app: { type: "positional", required: true }, ...conn },
  run: ({ args }) =>
    guard(async () => {
      const r = await client(args)<{ sha: string }>(`/apps/${args.app}/git/check`, "POST", {});
      console.log(`ok: branch head ${r.sha}`);
    }),
});

const deploy = defineCommand({
  meta: { name: "deploy", description: "Build and deploy the latest commit of the linked branch" },
  args: { app: { type: "positional", required: true }, wait: { type: "boolean", default: true, description: "wait for the result (--no-wait to return)" }, ...conn },
  run: ({ args }) =>
    guard(async () => {
      const call = client(args);
      const started = await call<{ id: string; coalesced: boolean }>(`/apps/${args.app}/git/deploy`, "POST", {});
      console.log(`${started.coalesced ? "joined waiting" : "queued"} deployment ${started.id}`);
      if (!args.wait) return;
      let offset = 0;
      for (let i = 0; i < 20 * 60; i++) {
        const [d, log] = await Promise.all([
          call<{ status: string; releaseId?: string; error?: string; commitSha?: string; commitSubject?: string }>(`/deployments/${started.id}`),
          call<{ text: string; next: number }>(`/deployments/${started.id}/log?from=${offset}`).catch(() => ({ text: "", next: offset })),
        ]);
        process.stdout.write(log.text);
        offset = log.next;
        if (d.status === "success") return void console.log(d.releaseId ? `deployed ${args.app} as ${d.releaseId}` : "already up to date");
        if (d.status === "failed") throw new Error(d.error ?? "deployment failed");
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("timed out waiting for the deployment");
    }),
});

const rotateSecret = defineCommand({
  meta: { name: "rotate-secret", description: "Create a new webhook secret (printed once)" },
  args: { app: { type: "positional", required: true }, ...conn },
  run: ({ args }) => guard(async () => console.log((await client(args)<{ webhookSecret: string }>(`/apps/${args.app}/git/rotate-secret`, "POST", {})).webhookSecret)),
});

const unlink = defineCommand({
  meta: { name: "unlink", description: "Stop deploying this app from Git" },
  args: { app: { type: "positional", required: true }, ...conn },
  run: ({ args }) =>
    guard(async () => {
      await client(args)(`/apps/${args.app}/git`, "DELETE");
      console.log(`unlinked ${args.app}`);
    }),
});

export const git = defineCommand({
  meta: { name: "git", description: "Deploy from a Git repository over SSH (talks to the API: --url/--token or $FREIGHTER_URL/$FREIGHTER_TOKEN)" },
  subCommands: { add, link, show: showCmd, check, deploy, "rotate-secret": rotateSecret, unlink },
});
