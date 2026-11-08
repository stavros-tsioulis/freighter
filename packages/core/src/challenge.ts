import { readFile } from "node:fs/promises";
import { ensureChallengeToken } from "@freighter/haproxy";
import type { Deps } from "./deps.ts";
import { haproxySync } from "./apply.ts";

/**
 * The token this server's HAProxy serves at `/.well-known/freighter-challenge` (see ensureChallengeToken). Makes sure
 * the running HAProxy actually has it: a server that hasn't deployed since the upgrade gets its backends re-rendered.
 */
export async function challengeToken(d: Deps): Promise<string> {
  const token = await ensureChallengeToken(d.config.haproxy.dir);
  const backends = await readFile(`${d.config.haproxy.dir}/backends.cfg`, "utf8").catch(() => "");
  if (!backends.includes(token)) await haproxySync(d);
  return token;
}
