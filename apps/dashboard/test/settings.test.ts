import { describe, expect, it } from "vitest";
import { emptyForm, fromSettings, hasService, imageHost, IMAGE_RE, imagesOnly, newRemoteVolume, newService, toSettings } from "../app/utils/settings";

describe("settings form", () => {
  it("only says what was chosen", () => {
    const f = emptyForm();
    f.services[0] = {
      ...newService("web"),
      command: " node server.js ",
      port: 3000,
      healthPath: "/up",
      env: [{ key: "NODE_ENV", value: "production" }, { key: " ", value: "ignored" }],
      secrets: "DATABASE_URL, API_KEY\n",
    };
    f.services.push({ ...newService("worker"), command: "run" });
    f.buildCommands = "npm ci\n\n npm run build \n";
    expect(toSettings(f)).toEqual({
      build: { commands: ["npm ci", "npm run build"] },
      services: {
        web: { command: "node server.js", port: 3000, replicas: 1, healthcheck: { path: "/up" }, restart: "on-failure", environment: { NODE_ENV: "production" }, secrets: ["DATABASE_URL", "API_KEY"] },
        worker: { command: "run", replicas: 1, restart: "on-failure" },
      },
      releases: { keep: 5 },
    });
  });

  it("round-trips stored settings", () => {
    const f = emptyForm();
    f.services[0] = { ...newService("web"), command: "run", memory: "512M", cpu: 1.5, healthPath: "/h", healthTimeout: "1m", restart: "always" };
    const again = fromSettings(toSettings(f));
    expect(again.services[0]).toMatchObject({ name: "web", memory: "512M", cpu: 1.5, healthPath: "/h", healthTimeout: "1m", restart: "always" });
    expect(fromSettings(null).services).toHaveLength(1);
    f.services[0]!.env = [{ key: "A", value: "1" }];
    f.services[0]!.secrets = "S";
    expect(fromSettings(toSettings(f)).services[0]).toMatchObject({ env: [{ key: "A", value: "1" }], secrets: "S" });
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

describe("volumes", () => {
  it("sends the volumes of a command service too, and remote volumes by type", () => {
    const f = emptyForm();
    f.services[0] = { ...newService("web"), command: "run", volumes: [{ name: "up", path: "/data/up" }, { name: "", path: "/x" }] };
    f.remoteVolumes = [
      { ...newRemoteVolume(), name: "media", type: "smb", host: " nas.lan ", share: "media", user: "svc", domain: "WG", export: "ignored" },
      { ...newRemoteVolume(), name: "arch", type: "nfs", host: "10.0.0.5", export: "/exports/a", version: "4.1", share: "ignored" },
      { ...newRemoteVolume(), name: "", host: "dropped" },
    ];
    const s = toSettings(f);
    expect(s.services.web!.volumes).toEqual({ up: "/data/up" });
    expect(s.volumes).toEqual({
      media: { type: "smb", host: "nas.lan", share: "media", user: "svc", domain: "WG" },
      arch: { type: "nfs", host: "10.0.0.5", export: "/exports/a", version: "4.1" },
    });
    const again = fromSettings(s);
    expect(again.remoteVolumes.map((v) => [v.name, v.type, v.host])).toEqual([["media", "smb", "nas.lan"], ["arch", "nfs", "10.0.0.5"]]);
    expect(again.services[0]!.volumes).toEqual([{ name: "up", path: "/data/up" }]);
  });
});

describe("app-level environment", () => {
  it("round-trips the app's environment and the build's, apart from the services' own", async () => {
    const { fromSettings, toSettings } = await import("../app/utils/settings");
    const settings = {
      build: { commands: ["make"], environment: { PUBLIC_URL: "https://x.example.com" } },
      environment: { REGION: "eu", API: "@api.url" },
      services: { api: { command: "node a.js", environment: { LOG: "debug" } } },
    };
    const form = fromSettings(settings as never);
    expect(form.env).toEqual([{ key: "REGION", value: "eu" }, { key: "API", value: "@api.url" }]);
    expect(form.buildEnv).toEqual([{ key: "PUBLIC_URL", value: "https://x.example.com" }]);
    expect(form.services[0]!.env).toEqual([{ key: "LOG", value: "debug" }]);
    const back = toSettings(form);
    expect(back.environment).toEqual({ REGION: "eu", API: "@api.url" });
    expect(back.build?.environment).toEqual({ PUBLIC_URL: "https://x.example.com" });
    expect(back.services.api!.environment).toEqual({ LOG: "debug" });
  });
  it("sends nothing for empty rows, and a build environment only with build commands", async () => {
    const { emptyForm, toSettings, newService } = await import("../app/utils/settings");
    const f = emptyForm();
    f.services = [{ ...newService("web"), command: "x" }];
    f.env = [{ key: "", value: "x" }];
    f.buildEnv = [{ key: "A", value: "b" }];
    const s = toSettings(f);
    expect(s.environment).toBeUndefined();
    expect(s.build).toBeUndefined(); // no commands, so no build to give variables to
  });
});

describe("image references", () => {
  it("take the docker:// form that skopeo and podman print, and send the plain reference", async () => {
    const { isImage, normalizeImage, imageHost, toSettings, emptyForm, newService } = await import("../app/utils/settings");
    expect(normalizeImage(" docker://ghcr.io/stavros-tsioulis/blog-waline:98a9350 ")).toBe("ghcr.io/stavros-tsioulis/blog-waline:98a9350");
    expect(isImage("docker://ghcr.io/stavros-tsioulis/blog-waline:98a9350")).toBe(true);
    expect(isImage("https://ghcr.io/org/app")).toBe(false);
    expect(imageHost("docker://ghcr.io/org/app:1")).toBe("ghcr.io");
    const f = emptyForm();
    f.services = [{ ...newService("blog", "image"), image: "docker://ghcr.io/stavros-tsioulis/blog-waline:98a9350" }];
    expect(toSettings(f).services.blog!.image).toBe("ghcr.io/stavros-tsioulis/blog-waline:98a9350");
  });
});

describe("volume choices", () => {
  it("offer the remote folders and what other services use, not the service's own", async () => {
    const { emptyForm, newService, newRemoteVolume, volumeChoices } = await import("../app/utils/settings");
    const f = emptyForm();
    f.remoteVolumes = [{ ...newRemoteVolume(), name: "media", type: "nfs" }];
    f.services = [
      { ...newService("web"), volumes: [{ name: "uploads", path: "/u" }] },
      { ...newService("worker"), volumes: [{ name: "cache", path: "/c" }, { name: "media", path: "/m" }] },
    ];
    expect(volumeChoices(f, 0)).toEqual([{ name: "media", detail: "remote folder (NFS)" }, { name: "cache", detail: "also used by worker" }]);
    expect(volumeChoices(f, "worker").map((c) => c.name)).toEqual(["media", "uploads"]);
    expect(volumeChoices(f, 5).map((c) => c.name)).toEqual(["media", "uploads", "cache"]);
  });
});
