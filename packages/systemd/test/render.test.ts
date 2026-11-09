import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseManifest } from "@freighter/manifest";
import { renderUnit } from "../src/index.ts";

const manifest = parseManifest(readFileSync(new URL("../../../examples/app.yaml", import.meta.url), "utf8"));
const render = (service: string) => renderUnit({ app: manifest.name, service, def: manifest.services[service]!, environment: manifest.services[service]!.environment });

const WEB = `[Unit]
Description=Freighter myapp/web
X-Freighter-App=myapp
X-Freighter-Service=web
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/srv/apps/myapp/current
ExecStart=/usr/bin/env node .output/server/index.mjs
Environment="NODE_ENV=production"
EnvironmentFile=-/etc/freighter/apps/myapp/web.env
Environment=PORT=3100
Restart=on-failure
RestartSec=3
CPUAccounting=true
MemoryAccounting=true
MemoryMax=256M
CPUQuota=80%
TasksMax=512
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/srv/apps/myapp/shared

[Install]
WantedBy=multi-user.target
`;

describe("renderUnit", () => {
  it("matches golden output for web", () => {
    expect(render("web")).toBe(WEB);
  });
  it("omits port and cpu when unset (worker)", () => {
    const out = render("worker");
    expect(out).toContain("MemoryMax=128M");
    expect(out).not.toContain("CPUQuota");
    expect(out).not.toContain("Environment=PORT");
  });
  it("binds routed services to the IPv4 loopback by default, below anything the app sets itself", () => {
    const def = manifest.services.web!;
    const out = renderUnit({ app: "a", service: "w", def, port: 3101, loopback: true, environment: { HOST: "0.0.0.0" } });
    expect(out.indexOf("Environment=HOST=127.0.0.1")).toBeGreaterThan(-1);
    expect(out.indexOf("Environment=HOST=127.0.0.1")).toBeLessThan(out.indexOf('Environment="HOST=0.0.0.0"'));
    expect(out.indexOf("Environment=HOST=127.0.0.1")).toBeLessThan(out.indexOf("EnvironmentFile="));
    expect(renderUnit({ app: "a", service: "w", def, port: 3101 })).not.toContain("HOST=");
    expect(renderUnit({ app: "a", service: "w", def: manifest.services.worker!, loopback: true })).not.toContain("HOST=");
  });
  it.each(["always", "on-failure", "no"] as const)("maps restart=%s", (restart) => {
    const def = { ...manifest.services.web!, restart };
    expect(renderUnit({ app: "a", service: "w", def })).toContain(`Restart=${restart}\n`);
  });
  it("rounds cpu quota and lets port/instance override", () => {
    const def = { ...manifest.services.web!, resources: { cpu: 0.29 } };
    const out = renderUnit({ app: "a", service: "w", def, port: 3101, instance: "r2" });
    expect(out).toContain("CPUQuota=29%");
    expect(out).toContain("Environment=PORT=3101");
    expect(out).toContain("Description=Freighter a/w (r2)");
  });
  it("escapes environment values and rejects bad keys", () => {
    const def = manifest.services.web!;
    const out = renderUnit({ app: "a", service: "w", def, environment: { Z: 'a"b\\c%d', A: "1" } });
    expect(out).toContain('Environment="A=1"\nEnvironment="Z=a\\"b\\\\c%%d"\n');
    expect(() => renderUnit({ app: "a", service: "w", def, environment: { "a b": "x" } })).toThrow();
    expect(() => renderUnit({ app: "a", service: "w", def, environment: { A: "x\ny" } })).toThrow();
  });
  it("runs from an explicit release directory when given", () => {
    const out = renderUnit({ app: "a", service: "w", def: manifest.services.web!, release: "r1", instance: "r1" });
    expect(out).toContain("WorkingDirectory=/srv/apps/a/releases/r1\n");
  });
  it("rejects hostile names", () => {
    expect(() => renderUnit({ app: "a\nExecStart=/bin/sh", service: "w", def: manifest.services.web! })).toThrow();
  });
});

describe("renderUnit for image services", () => {
  const img = parseManifest(
    "name: shop\nservices:\n  web:\n    image: ghcr.io/org/shop:1.2\n    port: 3000\n    containerPort: 8080\n    resources:\n      memory: 512M\n      cpu: 1\n    volumes:\n      uploads: /var/uploads\n    environment:\n      NODE_ENV: production\n    secrets:\n      - DB_URL\n",
  );
  const run = (extra: Partial<Parameters<typeof renderUnit>[0]> = {}) =>
    renderUnit({ app: "shop", service: "web", def: img.services.web!, environment: img.services.web!.environment, secrets: img.services.web!.secrets, port: 21000, loopback: true, ...extra });

  it("runs podman with the pinned digest, forwarding the environment by name", () => {
    const digest = `ghcr.io/org/shop@sha256:${"b".repeat(64)}`;
    const out = run({ image: digest, instance: "r1" });
    expect(out).toContain(
      `ExecStart=/usr/bin/podman --cgroup-manager=cgroupfs run --rm --name freighter-shop--web--r1 --pull=never --cgroups=no-conmon --log-driver=journald -p 127.0.0.1:21000:8080 -e DB_URL -e HOST -e NODE_ENV -e PORT -v /srv/apps/shop/shared/volumes/uploads:/var/uploads:Z ${digest}`,
    );
    expect(out).toContain("ExecStop=/usr/bin/podman --cgroup-manager=cgroupfs stop --ignore --time 10 freighter-shop--web--r1");
    expect(out).toContain("Environment=PORT=21000");
    expect(out).toContain("Environment=HOST=127.0.0.1");
    expect(out).toContain("MemoryMax=512M");
    expect(out).toContain("CPUQuota=100%");
    expect(out).toContain("Delegate=yes");
  });
  it("publishes onto the port the image was found to listen on, unless app.yaml says otherwise", () => {
    expect(run({ def: { ...img.services.web!, containerPort: undefined }, containerPort: 3000 })).toContain("-p 127.0.0.1:21000:3000 ");
    expect(run({ containerPort: 3000 })).toContain("-p 127.0.0.1:21000:8080 "); // containerPort: 8080 in app.yaml wins
    expect(run({ def: { ...img.services.web!, containerPort: undefined } })).toContain("-p 127.0.0.1:21000:21000 ");
  });
  it("never puts values on the command line", () => {
    expect(run()).not.toMatch(/ExecStart=.*production/);
  });
  it("keeps NoNewPrivileges out (rootless Podman needs newuidmap)", () => {
    expect(run()).not.toContain("NoNewPrivileges");
  });
  it("does not publish a port for a service without one", () => {
    const out = run({ port: undefined, def: { ...img.services.web!, port: undefined }, loopback: false });
    expect(out).not.toContain(" -p ");
    expect(out).not.toContain("-e PORT");
  });
  it("refuses image references that could break out of the unit file", () => {
    for (const image of ["a b", 'a"b', "a;b", "a$b", "a%b"]) expect(() => run({ image })).toThrow(/illegal image/);
  });
  it("gives rootless Podman a runtime directory of its own, made by the unit, with no login session needed", () => {
    const out = run();
    expect(out).toContain("RuntimeDirectory=freighter-shop");
    expect(out).toContain("RuntimeDirectoryMode=0700");
    expect(out).toContain("RuntimeDirectoryPreserve=yes");
    expect(out).toContain("Environment=XDG_RUNTIME_DIR=/run/freighter-shop");
    expect(out).not.toContain("/run/user");
  });
  it("leaves command services untouched", () => {
    expect(render("web")).toBe(WEB);
  });
});
