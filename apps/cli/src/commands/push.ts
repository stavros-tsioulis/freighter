import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { parseManifest } from "@freighter/manifest";
import { defineCommand } from "citty";
import { guard } from "../common.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function appNameOf(source: string, isDir: boolean): Promise<string> {
  let text: string;
  if (isDir) {
    text = await readFile(join(source, "app.yaml"), "utf8").catch(() => {
      throw new Error(`${source}/app.yaml not found (the artifact must contain app.yaml at its root)`);
    });
  } else {
    text = (await execFileP("tar", ["-xzOf", source, "app.yaml"]).catch(() => execFileP("tar", ["-xzOf", source, "./app.yaml"]).catch(() => {
      throw new Error(`${source} does not contain app.yaml at its root`);
    }))).stdout;
  }
  return parseManifest(text).name;
}


/** Poll a deployment until it succeeds (printing its progress), fails (throws) or runs out of time. */
export async function waitForDeployment(base: string, token: string, id: string, app: string): Promise<void> {
  const deadline = Date.now() + 30 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const d = (await (await fetch(`${base}/api/v1/deployments/${id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      status: string; releaseId?: string; error?: string; warnings?: string[];
    };
    if (d.status !== last) console.log(`  ${d.status}`);
    last = d.status;
    if (d.status === "success") {
      for (const w of d.warnings ?? []) console.warn(`warning: ${w}`);
      console.log(`deployed ${app} as ${d.releaseId}`);
      return;
    }
    if (d.status === "failed") throw new Error(d.error ?? "deployment failed");
    await sleep(1000);
  }
  throw new Error("timed out waiting for the deployment");
}

/** The app.yaml of an app that runs one image, for `freighter push --image`. */
export function imageManifest(name: string, image: string, port?: number): string {
  const manifest = `name: ${name}\nservices:\n  web:\n    image: ${image}\n${port !== undefined ? `    port: ${port}\n` : ""}`;
  parseManifest(manifest); // reject a bad name or image reference here, with the schema's message
  return manifest;
}

/** Queue an image deployment (nothing to upload) and, unless told not to, wait for it. */
export async function pushImages(base: string, token: string, app: string, manifest: string, opts: { server?: string; wait: boolean; logins?: Record<string, string> }): Promise<void> {
  const query = opts.server ? `?server=${encodeURIComponent(opts.server)}` : "";
  const res = await fetch(`${base}/api/v1/apps/${app}/image-deployments${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ manifest, ...(opts.logins ? { logins: opts.logins } : {}) }),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (res.status !== 202 || !json.id) throw new Error(`deploy failed (${res.status}): ${json.error?.message ?? res.statusText}`);
  console.log(`queued deployment ${json.id} for ${app}`);
  if (opts.wait) await waitForDeployment(base, token, json.id, app);
}

export const push = defineCommand({
  meta: { name: "push", description: "Upload a directory or .tar.gz to a Freighter API and deploy it, or deploy images from a registry (for CI)" },
  args: {
    source: { type: "positional", required: false, description: "Directory (with app.yaml), .tar.gz, or an app.yaml whose services all use `image:`" },
    image: { type: "string", description: "Deploy this image instead of a source, e.g. ghcr.io/org/app:1.2 (needs --name)" },
    name: { type: "string", description: "App name for --image" },
    login: { type: "string", description: "Which registry login the images are pulled with, as host=username (e.g. ghcr.io=alice), when a registry has several; remembered for the app" },
    port: { type: "string", description: "Port the image listens on, for --image (the service is then routable; set containerPort in app.yaml for more control)" },
    url: { type: "string", description: "API base URL (or $FREIGHTER_URL)" },
    token: { type: "string", description: "API token (or $FREIGHTER_TOKEN)" },
    server: { type: "string", description: "Target server for a new app (apps are pinned to their first server)" },
    wait: { type: "boolean", default: true, description: "Wait for the deployment to finish (--no-wait to return immediately)" },
  },
  run: ({ args }) =>
    guard(async () => {
      const base = (args.url ?? process.env.FREIGHTER_URL ?? "").replace(/\/+$/, "");
      const token = args.token ?? process.env.FREIGHTER_TOKEN;
      if (!base) throw new Error("no API URL: pass --url or set FREIGHTER_URL");
      if (!token) throw new Error("no API token: pass --token or set FREIGHTER_TOKEN");

      let logins: Record<string, string> | undefined;
      if (args.login !== undefined) {
        const [host, ...user] = args.login.split("=");
        if (!host || user.length === 0 || !user.join("=")) throw new Error(`--login takes host=username, e.g. ghcr.io=alice (got "${args.login}")`);
        logins = { [host]: user.join("=") };
      }
      if (args.image !== undefined) {
        if (!args.name) throw new Error("--image needs --name (the app's name)");
        const port = args.port === undefined ? undefined : Number(args.port);
        if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`invalid --port "${args.port}"`);
        return pushImages(base, token, args.name, imageManifest(args.name, args.image, port), { server: args.server, wait: args.wait, logins });
      }
      if (!args.source) throw new Error("nothing to deploy: pass a directory, an artifact, an app.yaml or --image");
      if (/\.ya?ml$/.test(args.source)) {
        const manifest = await readFile(args.source, "utf8").catch(() => {
          throw new Error(`source not found: ${args.source}`);
        });
        return pushImages(base, token, parseManifest(manifest).name, manifest, { server: args.server, wait: args.wait, logins });
      }

      const info = await stat(args.source).catch(() => {
        throw new Error(`source not found: ${args.source}`);
      });
      const app = await appNameOf(args.source, info.isDirectory());
      let file = args.source;
      let tmp: string | undefined;
      if (info.isDirectory()) {
        tmp = await mkdtemp(join(tmpdir(), "freighter-push-"));
        file = join(tmp, "artifact.tar.gz");
        await execFileP("tar", ["-czf", file, "-C", args.source, "."]);
      }
      try {
        const size = (await stat(file)).size;
        const query = args.server ? `?server=${encodeURIComponent(args.server)}` : "";
        const res = await fetch(`${base}/api/v1/apps/${app}/deployments${query}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/gzip", "content-length": String(size) },
          body: Readable.toWeb(createReadStream(file)) as never,
          duplex: "half",
        } as RequestInit);
        const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
        if (res.status !== 202 || !json.id) throw new Error(`upload failed (${res.status}): ${json.error?.message ?? res.statusText}`);
        console.log(`queued deployment ${json.id} for ${app}`);
        if (!args.wait) return;

        await waitForDeployment(base, token, json.id, app);
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    }),
});
