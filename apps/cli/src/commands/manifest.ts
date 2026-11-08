import { parseManifest } from "@freighter/manifest";
import { renderUnit } from "@freighter/systemd";
import { defineCommand } from "citty";
import { fileArg, guard, readManifestText } from "../common.ts";

export const validate = defineCommand({
  meta: { name: "validate", description: "Parse and validate a manifest" },
  args: { ...fileArg },
  run: ({ args }) =>
    guard(() => {
      const m = parseManifest(readManifestText(args.file));
      console.log(`ok: ${m.name} (${Object.keys(m.services).join(", ")})`);
    }),
});

export const unit = defineCommand({
  meta: { name: "unit", description: "Print the generated systemd unit for a service" },
  args: { service: { type: "positional", required: true }, ...fileArg },
  run: ({ args }) =>
    guard(() => {
      const m = parseManifest(readManifestText(args.file));
      const def = m.services[args.service];
      if (!def) throw new Error(`unknown service "${args.service}" (have: ${Object.keys(m.services).join(", ")})`);
      process.stdout.write(renderUnit({ app: m.name, service: args.service, def, environment: m.environment, secrets: m.secrets, uid: 1000 }));
    }),
});
