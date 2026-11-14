import { defineCommand } from "citty";
import { app } from "../host/app.ts";
import { deploy } from "../host/deploy.ts";
import { certs, haproxy } from "../host/haproxy.ts";
import { token } from "../host/token.ts";
import { unit } from "../lib/manifest-cmds.ts";

/** What runs on the machine itself, as root (or as the `freighter` user): no API, no token. See docs/cli/host. */
export const host = defineCommand({
  meta: { name: "host", description: "On this server itself, as root: first token, local deploy, HAProxy, certificates" },
  subCommands: { token, deploy, unit, haproxy, certs, app },
});
