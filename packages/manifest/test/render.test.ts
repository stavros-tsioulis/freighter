import { describe, expect, it } from "vitest";
import { parseManifest, renderManifest } from "../src/index.ts";

describe("renderManifest", () => {
  it("round-trips UI settings through the manifest parser", () => {
    const text = renderManifest("shop", {
      build: { commands: ["npm ci", "npm run build"] },
      services: { web: { command: "node server.js --port $PORT: \"x\"", port: 3000, healthcheck: { path: "/up" } } },
      environment: { NODE_ENV: "production" },
      secrets: ["DATABASE_URL"],
    });
    const m = parseManifest(text);
    expect(m.name).toBe("shop");
    expect(m.services.web!.command).toBe('node server.js --port $PORT: "x"');
    expect(m.build!.commands).toEqual(["npm ci", "npm run build"]);
    expect(m.secrets).toEqual(["DATABASE_URL"]);
  });

  it("rejects what app.yaml would reject", () => {
    expect(() => renderManifest("shop", { services: {} } as never)).not.toThrow();
    expect(() => renderManifest("shop", { services: { web: { command: "x" } }, secrets: ["lower"] })).toThrow();
    expect(() => renderManifest("Shop", { services: { web: { command: "x" } } })).toThrow();
  });
});
