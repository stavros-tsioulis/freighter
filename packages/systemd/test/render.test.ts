import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseManifest } from "@freighter/manifest";
import { renderUnit } from "../src/index.ts";

const manifest = parseManifest(readFileSync(new URL("../../../examples/app.yaml", import.meta.url), "utf8"));
const render = (service: string) => renderUnit({ app: manifest.name, service, def: manifest.services[service]!, environment: manifest.environment });

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
EnvironmentFile=-/etc/freighter/apps/myapp.env
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
