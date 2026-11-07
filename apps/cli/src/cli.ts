#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { deploy } from "./commands/deploy.ts";
import { domain } from "./commands/domain.ts";
import { git } from "./commands/git.ts";
import { sshKey } from "./commands/ssh-key.ts";
import { certs, haproxy } from "./commands/haproxy.ts";
import { push } from "./commands/push.ts";
import { server } from "./commands/server.ts";
import { token } from "./commands/token.ts";
import { unit, validate } from "./commands/manifest.ts";
import { env, logs, releases, restart, rollback, start, status, stop } from "./commands/ops.ts";

const main = defineCommand({
  meta: { name: "freighter", description: "Containerless app deployment on systemd" },
  subCommands: { validate, unit, deploy, rollback, releases, status, logs, start, stop, restart, env, domain, haproxy, certs, token, push, server, git, "ssh-key": sshKey },
});

await runMain(main);
