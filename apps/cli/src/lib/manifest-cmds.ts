import { parseManifest } from "@freighter/manifest";
import { renderUnit } from "@freighter/systemd";
import { defineCommand } from "citty";
import { fileArg, guard, readManifestText } from "../common.ts";

export const validate = defineCommand({
  meta: { name: "validate", description: "Check an app.yaml: no server and no sign-in needed" },
  args: { path: { type: "positional", required: false, description: "The app.yaml (default: ./app.yaml)", default: "app.yaml" } },
  run: ({ args }) =>
    guard(() => {
      const m = parseManifest(readManifestText(args.path));
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
      process.stdout.write(renderUnit({ app: m.name, service: args.service, def, environment: def.environment, secrets: def.secrets }));
    }),
});
