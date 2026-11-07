import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Tests run the built CLI, the same file that ships, so build it once before any test starts. */
export default function setup() {
  const root = join(import.meta.dirname, "..");
  execFileSync(process.execPath, [join(root, "../../scripts/bundle.mjs"), "src/cli.ts", "dist/cli.js"], { cwd: root, stdio: "inherit" });
}
