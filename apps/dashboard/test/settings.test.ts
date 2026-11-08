import { describe, expect, it } from "vitest";
import { emptyForm, fromSettings, hasService, imageHost, IMAGE_RE, imagesOnly, newService, toSettings } from "../app/utils/settings";

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

describe("image services", () => {
  const image = () => ({ ...newService("web", "image"), image: " ghcr.io/acme/shop:1.4 ", containerPort: 8080, port: 3000, volumes: [{ name: "uploads", path: "/var/uploads" }, { name: "", path: "/x" }] });

  it("says image, not command, and drops empty volume rows", () => {
    const f = emptyForm();
    f.services[0] = image();
    expect(toSettings(f).services.web).toEqual({
      image: "ghcr.io/acme/shop:1.4",
      containerPort: 8080,
      volumes: { uploads: "/var/uploads" },
      port: 3000,
      replicas: 1,
      restart: "on-failure",
    });
  });

  it("round-trips, and knows which kind a stored service is", () => {
    const f = emptyForm();
    f.services = [image(), { ...newService("worker"), command: "run" }];
    const again = fromSettings(toSettings(f));
    expect(again.services[0]).toMatchObject({ kind: "image", image: "ghcr.io/acme/shop:1.4", containerPort: 8080, volumes: [{ name: "uploads", path: "/var/uploads" }] });
    expect(again.services[1]).toMatchObject({ kind: "command", command: "run" });
  });

  it("is deployable with an image and no command, and imagesOnly says when nothing needs uploading", () => {
    const f = emptyForm();
    f.services[0] = { ...newService("web", "image") };
    expect(hasService(f)).toBe(false);
    f.services[0]!.image = "nginx";
    expect(hasService(f)).toBe(true);
    expect(imagesOnly(f)).toBe(true);
    f.services.push({ ...newService("api"), command: "run" });
    expect(imagesOnly(f)).toBe(false);
  });

  it("checks references and finds the registry", () => {
    for (const ok of ["nginx", "ghcr.io/acme/shop:1.4", "localhost:5000/app", `acme/app@sha256:${"a".repeat(64)}`]) expect(IMAGE_RE.test(ok)).toBe(true);
    for (const bad of ["Nginx", "a b", "a;b", "-v /:/x", ""]) expect(IMAGE_RE.test(bad)).toBe(false);
    expect(imageHost("ghcr.io/acme/shop:1")).toBe("ghcr.io");
    expect(imageHost("localhost:5000/app")).toBe("localhost:5000");
    expect(imageHost("nginx")).toBe("docker.io");
    expect(imageHost("acme/app")).toBe("docker.io");
  });
});
