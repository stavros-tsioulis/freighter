import { readFileSync } from "node:fs";
import { defaultDeps } from "@freighter/core";
import { ZodError } from "zod";

export const common = {
  prefix: {
    type: "string",
    description: "Dev mode: relocate all paths under this dir and skip systemctl/useradd",
  },
} as const;

export const fileArg = {
  file: { type: "string", alias: "f", description: "Path to app.yaml", default: "app.yaml" },
} as const;

export const depsFrom = (args: { prefix?: string }) => defaultDeps({ prefix: args.prefix });  // async

export function readManifestText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read manifest: ${file}`);
  }
}

/** Run a command body; print expected failures as one-line errors with exit code 1. */
export async function guard(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ZodError) {
      console.error("invalid manifest:\n" + e.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"));
    } else {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }
}
