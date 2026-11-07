import { defineConfig } from "vitest/config";

// Each test spawns the CLI several times (tsx start-up), so allow more than the 5s default.
export default defineConfig({ test: { testTimeout: 30_000 } });
