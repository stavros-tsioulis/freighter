import { deploy as runDeploy } from "@freighter/core";
import { defineCommand } from "citty";
import { common, depsFrom, fileArg, guard, readManifestText } from "../common.ts";

export const deploy = defineCommand({
  meta: { name: "deploy", description: "Deploy a directory or .tar.gz artifact (run on the VPS, as root)" },
  args: {
    source: { type: "positional", required: true, description: "Directory or .tar.gz/.tgz artifact" },
    "dry-run": { type: "boolean", description: "Show what would happen without changing anything" },
    verify: { type: "boolean", default: true, description: "Health-check the new release and roll back on failure (--no-verify to skip)" },
    ...fileArg,
    ...common,
  },
  run: ({ args }) =>
    guard(async () => {
      const r = await runDeploy(await depsFrom(args), {
        manifestText: readManifestText(args.file),
        source: args.source,
        dryRun: args["dry-run"],
        skipVerify: !args.verify || Boolean(args.prefix), // nothing real runs under --prefix
      });
      for (const w of r.warnings) console.warn(`warning: ${w}`);
      const verb = r.dryRun ? "would deploy" : "deployed";
      console.log(`${verb} ${r.app} as ${r.releaseId}${r.verified ? " (healthy)" : ""}`);
      for (const u of r.units) console.log(`  unit    ${u}`);
      for (const h of r.hostnames) console.log(`  route   ${h}`);
      for (const u of r.removed) console.log(`  ${r.dryRun ? "would remove" : "removed"} ${u}`);
      if (r.pruned.length > 0) console.log(`  pruned  ${r.pruned.join(", ")}`);
    }),
});
