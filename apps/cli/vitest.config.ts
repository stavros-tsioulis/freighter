import { defineConfig } from "vitest/config";

// Tests spawn the built CLI several times, so allow more than the 5s default.
export default defineConfig({ test: { testTimeout: 30_000, globalSetup: ["./test/build.ts"] } });
