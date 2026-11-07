import { defineConfig } from "vitest/config";

// Only pure utilities are unit-tested here; pages are covered by typecheck + build.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
