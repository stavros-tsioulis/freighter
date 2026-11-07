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

export const push = defineCommand({
  meta: { name: "push", description: "Upload a directory or .tar.gz to a Freighter API and deploy it (for CI)" },
  args: {
    source: { type: "positional", required: true, description: "Directory (with app.yaml) or .tar.gz" },
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

        const deadline = Date.now() + 20 * 60_000;
        let last = "";
        while (Date.now() < deadline) {
          const d = (await (await fetch(`${base}/api/v1/deployments/${json.id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
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
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    }),
});
