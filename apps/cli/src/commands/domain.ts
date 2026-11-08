import { readDomains, setDomains } from "@freighter/core";
import { defineCommand } from "citty";
import { common, depsFrom, guard } from "../common.ts";

/** `host` or `host=service` or `host=service:off` (tls defaults to auto). */
function parseSpec(spec: string, fallbackService?: string) {
  const [hostname = "", rest = ""] = spec.split("=");
  const [service = fallbackService ?? "", tls = "auto"] = rest.split(":");
  if (!service) throw new Error(`"${spec}": say which service it routes to, e.g. ${hostname}=web`);
  if (tls !== "auto" && tls !== "off") throw new Error(`"${spec}": tls must be auto or off`);
  return { hostname, service, tls } as const;
}

const apply = async (args: Parameters<typeof depsFrom>[0] & { app: string }, change: (cur: Awaited<ReturnType<typeof readDomains>>) => { hostname: string; service: string; tls: "auto" | "off" }[]) => {
  const d = await depsFrom(args);
  const r = await setDomains(d, args.app, change(await readDomains(d, args.app)), { skipVerify: Boolean(args.prefix) });
  console.log(
    r.deploy
      ? `applied to ${args.app} as ${r.deploy.releaseId} (a service got its first domain, so the release was redeployed)`
      : r.mode === "routing"
        ? "routing updated; the app was not redeployed. A service that lost its last domain keeps running until the next deploy"
        : r.mode === "unchanged"
          ? "nothing changed"
          : "saved (nothing to redeploy)",
  );
  for (const x of r.domains) console.log(`  ${x.hostname} -> ${x.service}  tls ${x.tls}`);
};

const list = defineCommand({
  meta: { name: "list", description: "Show an app's domains" },
  args: { app: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(async () => {
      const domains = await readDomains(await depsFrom(args), args.app);
      if (domains.length === 0) return void console.log("no domains");
      for (const x of domains) console.log(`${x.hostname} -> ${x.service}  tls ${x.tls}`);
    }),
});

const add = defineCommand({
  meta: { name: "add", description: "Route a hostname to a service: host=service[:auto|off]. A deployed app is redeployed with the new routing." },
  args: { app: { type: "positional", required: true }, spec: { type: "positional", required: true, description: "e.g. shop.example.com=web or shop.localhost=web:off" }, ...common },
  run: ({ args }) =>
    guard(() => {
      const one = parseSpec(args.spec);
      return apply(args, (cur) => [...cur.filter((x) => x.hostname !== one.hostname), one]);
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Stop routing a hostname to the app" },
  args: { app: { type: "positional", required: true }, hostname: { type: "positional", required: true }, ...common },
  run: ({ args }) =>
    guard(() =>
      apply(args, (cur) => {
        if (!cur.some((x) => x.hostname === args.hostname)) throw new Error(`${args.hostname} is not one of ${args.app}'s domains`);
        return cur.filter((x) => x.hostname !== args.hostname);
      }),
    ),
});

export const domain = defineCommand({
  meta: { name: "domain", description: "An app's domains (they are not part of app.yaml; run on the app's server, as root)" },
  subCommands: { list, add, remove },
});
