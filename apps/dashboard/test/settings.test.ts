import { describe, expect, it } from "vitest";
import { emptyForm, fromSettings, hasService, newService, toSettings } from "../app/utils/settings";

describe("settings form", () => {
  it("only says what was chosen", () => {
    const f = emptyForm();
    f.services[0] = { ...newService("web"), command: " node server.js ", port: 3000, healthPath: "/up" };
    f.buildCommands = "npm ci\n\n npm run build \n";
    f.env = [{ key: "NODE_ENV", value: "production" }, { key: " ", value: "ignored" }];
    f.secrets = "DATABASE_URL, API_KEY\n";
    expect(toSettings(f)).toEqual({
      build: { commands: ["npm ci", "npm run build"] },
      services: { web: { command: "node server.js", port: 3000, replicas: 1, healthcheck: { path: "/up" }, restart: "on-failure" } },
      environment: { NODE_ENV: "production" },
      secrets: ["DATABASE_URL", "API_KEY"],
      releases: { keep: 5 },
    });
  });

  it("round-trips stored settings", () => {
    const f = emptyForm();
    f.services[0] = { ...newService("web"), command: "run", memory: "512M", cpu: 1.5, healthPath: "/h", healthTimeout: "1m", restart: "always" };
    const again = fromSettings(toSettings(f));
    expect(again.services[0]).toMatchObject({ name: "web", memory: "512M", cpu: 1.5, healthPath: "/h", healthTimeout: "1m", restart: "always" });
    expect(fromSettings(null).services).toHaveLength(1);
  });

  it("needs a service with a command before it can be deployed", () => {
    expect(hasService(emptyForm())).toBe(false);
    const f = emptyForm();
    f.services[0]!.command = "run";
    expect(hasService(f)).toBe(true);
  });
});
