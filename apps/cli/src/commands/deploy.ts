import { readFile, stat } from "node:fs/promises";
import { parseManifest } from "@freighter/manifest";
import { defineCommand } from "citty";
import type { Api } from "../lib/api.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { bytes } from "../lib/out.ts";
import { appYamlOf, pack } from "../lib/pack.ts";
import { globalArgs, run } from "../lib/run.ts";
import { appNameIn, target } from "../lib/target.ts";
import { finish, parseSpan } from "../lib/wait.ts";

const waitArgs = {
  wait: { type: "boolean", default: true, description: "Wait for the deployment (--no-wait returns its id)" },
  verbose: { type: "boolean", alias: "v", description: "Show the whole deployment log, not just the steps" },
  timeout: { type: "string", description: "Stop waiting after this long, e.g. 10m (the deployment carries on)" },
} as const;

/** The app.yaml of an app that runs one image. */
export function imageManifest(name: string, image: string, port?: number): string {
  const manifest = `name: ${name}\nservices:\n  web:\n    image: ${image}\n${port !== undefined ? `    port: ${port}\n` : ""}`;
  parseManifest(manifest); // a bad name or image reference is refused here, with the schema's message
  return manifest;
}

function logins(login: string | undefined): Record<string, string> | undefined {
  if (login === undefined) return undefined;
  const [host, ...user] = login.split("=");
  if (!host || !user.join("=")) throw usage(`--login takes <host>=<username>, like ghcr.io=alice (got "${login}")`);
  return { [host]: user.join("=") };
}

async function keyId(api: Api, nameOrId: string): Promise<string> {
  const { keys } = await api.get<{ keys: { id: string; name: string }[] }>("/ssh-keys");
  const k = keys.find((x) => x.name === nameOrId || x.id === nameOrId);
  if (!k) throw new CliError(`no imported SSH key named "${nameOrId}"`, EXIT.notFound, "see `freighter ssh-key list`");
  return k.id;
}

const isImageOnly = (manifest: string) => {
  try {
    const m = parseManifest(manifest, { legacy: true, raw: true });
    const services = Object.values(m.services);
    return services.length > 0 && services.every((s) => s.image !== undefined);
  } catch {
    return false;
  }
};

interface Link {
  publicKey?: string;
  webhookUrl: string;
}

export const deploy = defineCommand({
  meta: { name: "deploy", description: "Deploy a directory, an archive, an image or a Git repository" },
  args: {
    path: { type: "positional", required: false, description: "A directory, a .tar.gz, or an app.yaml (default: .)" },
    app: { type: "string", description: "The app (with --image: required)" },
    server: { type: "string", description: "Which server a new app goes on" },
    image: { type: "string", description: "Deploy this container image, e.g. ghcr.io/org/app:1.2" },
    port: { type: "string", description: "With --image: the port the app listens on" },
    login: { type: "string", description: "Which registry login pulls the images, as <host>=<username>" },
    git: { type: "string", description: "Create the app from this Git repository" },
    branch: { type: "string", description: "With --git: the branch", default: "main" },
    key: { type: "string", description: "With --git: an imported SSH key (default: a deploy key is made)" },
    subpath: { type: "string", description: "With --git: where in the repository the app is", default: "" },
    auto: { type: "boolean", default: true, description: "With --git: deploy on push (--no-auto to turn it off)" },
    "dry-run": { type: "boolean", description: "Check it and show what would happen; change nothing" },
    ...waitArgs,
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api, connection }) => {
      const wait = { wait: args.wait, verbose: args.verbose, timeoutMs: args.timeout ? parseSpan(args.timeout) : undefined };
      const host = new URL(connection().url).host;
      const query = args.server ? `?server=${encodeURIComponent(args.server)}` : "";
      const login = logins(args.login);

      // ---- from Git ----
      if (args.git !== undefined) {
        if (args["dry-run"]) throw usage("--dry-run doesn't apply to --git");
        const sshKeyId = args.key ? await keyId(api(), args.key) : null;
        const r = await api().post<{ app: string; deployment: { id: string }; link: Link; webhookSecret: string }>("/git/deployments", {
          repository: args.git, branch: args.branch, subpath: args.subpath, sshKeyId, autoDeploy: args.auto, ...(args.server ? { server: args.server } : {}),
        });
        out.step(`Linked ${r.app} to ${args.git}`);
        if (!sshKeyId && r.link.publicKey) out.note(`\nAdd this deploy key (read-only) to the repository:\n  ${r.link.publicKey}\n`);
        out.note(`Webhook for deploys on push:\n  URL     ${r.link.webhookUrl}\n  Secret  ${r.webhookSecret}  (shown once)\n`);
        out.step(`Deploying ${r.app} to ${host}`);
        return finish(api(), out, r.deployment, wait);
      }

      // ---- an image, from flags ----
      if (args.image !== undefined) {
        if (!args.app) throw usage("--image needs --app (the app to create or update)");
        const port = args.port === undefined ? undefined : Number(args.port);
        if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw usage(`invalid --port "${args.port}"`);
        const manifest = imageManifest(args.app, args.image, port);
        if (args["dry-run"]) return out.data({ app: args.app, image: args.image }, () => out.line(`Would deploy ${args.image} as ${args.app}${port ? ` on port ${port}` : ""}; ${args.app}'s configuration would be replaced.`));
        const q = await api().request<{ id: string }>("POST", `/apps/${args.app}/image-deployments`, { body: { manifest, ...(login ? { logins: login } : {}), replaceConfig: true }, query: args.server ? { server: args.server } : undefined });
        out.step(`Deploying ${args.app} to ${host}`);
        return finish(api(), out, q, wait);
      }

      // ---- a directory, an archive, or an app.yaml ----
      const path = args.path ?? ".";
      const info = await stat(path).catch(() => {
        throw new CliError(`${path} not found`, EXIT.notFound);
      });
      const isYaml = !info.isDirectory() && /\.ya?ml$/.test(path);
      let name: string;
      if (isYaml) name = parseManifest(await readFile(path, "utf8"), { legacy: true }).name;
      else if (info.isDirectory()) {
        const found = appNameIn(path);
        if (!found) throw new CliError(`no app.yaml in ${path}`, EXIT.failed, "an app is a directory with an app.yaml; see https://docs for the format");
        name = found;
      } else name = parseManifest(await appYamlOf(path), { legacy: true }).name;
      if (args.app && args.app !== name) throw usage(`the app is called ${name} in app.yaml, not ${args.app}`, "change name: in app.yaml, or leave --app out");

      if (isYaml) {
        const manifest = await readFile(path, "utf8");
        if (!isImageOnly(manifest)) throw usage(`${path} has services that run commands: deploy their directory, or an archive`, "an app.yaml alone can only deploy images");
        if (args["dry-run"]) return out.data({ app: name }, () => out.line(`Would deploy ${name} from ${path}.`));
        const q = await api().request<{ id: string }>("POST", `/apps/${name}/image-deployments`, { body: { manifest, ...(login ? { logins: login } : {}) }, query: args.server ? { server: args.server } : undefined });
        out.step(`Deploying ${name} to ${host}`);
        return finish(api(), out, q, wait);
      }

      const packed = await pack(path);
      try {
        if (info.isDirectory()) out.step(`Packing ${path}   ${bytes(packed.size)}, ${packed.files} files`);
        if (args["dry-run"]) {
          const known = await api().get<{ name: string }>(`/apps/${name}`).then(() => true, () => false);
          return out.data({ app: name, exists: known, files: packed.files, bytes: packed.size }, () =>
            out.line(known ? `Would upload ${bytes(packed.size)} and release it as a new version of ${name}. Its configuration is kept (change it with \`freighter config apply\`).` : `Would create ${name} on ${args.server ?? "the default server"} from its app.yaml, and upload ${bytes(packed.size)}.`),
          );
        }
        const q = await api().request<{ id: string }>("POST", `/apps/${name}/deployments`, { raw: { body: packed.stream(), type: "application/gzip", length: packed.size }, query: args.server ? { server: args.server } : undefined });
        out.step(`Deploying ${name} to ${host}`);
        await finish(api(), out, q, wait);
      } finally {
        await packed.cleanup();
      }
    }),
});

export const redeploy = defineCommand({
  meta: { name: "redeploy", description: "Release an app again: images pulled again, or a Git app built from the branch head" },
  args: { app: { type: "positional", required: false }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const linked = await api().get(`/apps/${app}/git`).then(() => true, () => false);
      const q = await api().post<{ id: string }>(linked ? `/apps/${app}/git/deploy` : `/apps/${app}/redeploy`);
      out.step(`Redeploying ${app}`);
      await finish(api(), out, q, { wait: args.wait, verbose: args.verbose, timeoutMs: args.timeout ? parseSpan(args.timeout) : undefined });
    }),
});

export const rollback = defineCommand({
  meta: { name: "rollback", description: "Go back to the previous release, or the one named" },
  args: { app: { type: "positional", required: false }, release: { type: "positional", required: false, description: "A release id (see `freighter release list`)" }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      // `freighter rollback r2026…` names a release of the app in this directory
      const releaseFirst = args.release === undefined && args.app !== undefined && /^r\d{8}-\d{6}(-\d+)?$/.test(args.app);
      const { app } = target(releaseFirst ? undefined : args.app);
      const release = releaseFirst ? args.app : args.release;
      const q = await api().post<{ id: string }>(`/apps/${app}/rollback`, release ? { release } : {});
      out.step(`Rolling ${app} back${release ? ` to ${release}` : ""}`);
      await finish(api(), out, q, { wait: args.wait, verbose: args.verbose, timeoutMs: args.timeout ? parseSpan(args.timeout) : undefined, verb: "rollback" });
    }),
});
