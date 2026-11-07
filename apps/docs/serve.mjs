// Serves the built site (.vitepress/dist) when the docs are deployed with Freighter. No dependencies.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, ".vitepress", "dist");
const port = Number(process.env.PORT ?? 3200);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon",
};

async function file(path) {
  const s = await stat(path).catch(() => null);
  return s?.isFile() ? path : null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") return res.end("ok");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  // Clean URLs: /guide/introduction -> guide/introduction.html, / -> index.html
  const base = join(root, rel);
  if (!base.startsWith(root)) return res.writeHead(400).end();
  const found = (await file(base)) ?? (await file(`${base}.html`)) ?? (await file(join(base, "index.html")));
  const path = found ?? join(root, "404.html");
  res.writeHead(found ? 200 : 404, {
    "content-type": types[extname(path)] ?? "application/octet-stream",
    "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(path).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`docs on :${port}`));
