import { certStatus, haproxySync, renewCerts } from "@freighter/core";
import { renderMainConfig, renderSnippet } from "@freighter/haproxy";
import { defineCommand } from "citty";
import { common, depsFrom, guard } from "../common.ts";

const setup = defineCommand({
  meta: { name: "setup", description: "Print the one-time lines to add to your existing HAProxy config" },
  args: { ...common },
  run: ({ args }) =>
    guard(async () => {
      const d = await depsFrom(args);
      process.stdout.write(renderSnippet(d.config.haproxy));
      if (!d.config.acme.email) {
        console.error("\nnote: set acme.email in /etc/freighter/config.yaml before deploying domains with `tls: auto`");
      }
    }),
});

const fullConfig = defineCommand({
  meta: { name: "config", description: "Print a complete haproxy.cfg for a Freighter-only HAProxy (servers without their own)" },
  args: { ...common },
  run: ({ args }) =>
    guard(async () => {
      const d = await depsFrom(args);
      process.stdout.write(renderMainConfig(d.config.haproxy));
    }),
});

const sync = defineCommand({
  meta: { name: "sync", description: "Regenerate HAProxy maps/backends from recorded state and reload if changed" },
  args: { ...common },
  run: ({ args }) =>
    guard(async () => {
      const r = await haproxySync(await depsFrom(args));
      console.log(`${r.routes} route(s); ${r.changed ? "config updated and haproxy reloaded" : "already up to date"}`);
    }),
});

export const haproxy = defineCommand({
  meta: { name: "haproxy", description: "Manage the HAProxy integration" },
  subCommands: { setup, config: fullConfig, sync },
});

const renew = defineCommand({
  meta: { name: "renew", description: "Issue or renew certificates for all tls: auto domains (run daily by a timer)" },
  args: { force: { type: "boolean", description: "Re-issue even if still valid" }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const out = await renewCerts(await depsFrom(args), { force: args.force });
      if (out.length === 0) console.log("no tls: auto domains");
      for (const c of out) console.log(`${c.issued ? "issued " : "valid  "} ${c.hostname}${c.expires ? `  expires ${c.expires.toISOString().slice(0, 10)}` : ""}`);
    }),
});

const certStatusCmd = defineCommand({
  meta: { name: "status", description: "Show certificate expiry per tls: auto hostname" },
  args: { ...common },
  run: ({ args }) =>
    guard(async () => {
      const out = await certStatus(await depsFrom(args));
      if (out.length === 0) console.log("no tls: auto domains");
      for (const c of out) console.log(`${c.hostname.padEnd(32)} ${c.expires ? `expires ${c.expires.toISOString().slice(0, 10)}` : "no certificate"}`);
    }),
});

export const certs = defineCommand({
  meta: { name: "certs", description: "Manage TLS certificates" },
  subCommands: { renew, status: certStatusCmd },
});
