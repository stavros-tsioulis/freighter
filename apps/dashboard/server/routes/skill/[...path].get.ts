import { useStorage } from "nitropack/runtime";
// The skills that teach an agent to use this Freighter: `/skill/cli` (the `freighter` CLI) and `/skill/mcp` (the MCP
// server), as Markdown, each with its reference files under `/skill/<name>/references/<file>`. They are the repository's
// own (.agents/skills), bundled into the server, so an agent can fetch them from the Freighter it will operate:
//   curl -fsSL https://freighter.example.com/skill/cli
const SKILLS: Record<string, string> = { cli: "freighter-cli", mcp: "freighter-mcp" };

export default defineEventHandler(async (event) => {
  const [name, ...rest] = (getRouterParam(event, "path") ?? "").split("/").filter(Boolean);
  const dir = name ? SKILLS[name] : undefined;
  if (!name || !dir) throw createError({ statusCode: 404, statusMessage: "unknown skill", message: `skills: ${Object.keys(SKILLS).join(", ")}` });
  const file = rest.length ? rest.join("/") : "SKILL.md";
  // only the skill's own markdown: SKILL.md or references/<name>.md
  if (!/^(SKILL\.md|references\/[A-Za-z0-9_-]+\.md)$/.test(file)) throw createError({ statusCode: 404, statusMessage: "not found" });
  const text = await useStorage("assets:skills").getItem<string>(`${dir}:${file.replaceAll("/", ":")}`);
  if (typeof text !== "string") throw createError({ statusCode: 404, statusMessage: "not found" });
  const origin = getRequestURL(event, { xForwardedProto: true, xForwardedHost: true }).origin;
  setResponseHeader(event, "content-type", "text/markdown; charset=utf-8");
  setResponseHeader(event, "cache-control", "no-cache");
  // the skill's links to its references point at this server, and it says which Freighter it is for
  const body = text.replaceAll("`references/", `\`${origin}/skill/${name}/references/`);
  return file === "SKILL.md" ? body.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n> Served by ${origin}. The Freighter to operate is this one.\n`) : body;
});
