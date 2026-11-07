import type { Service } from "@freighter/manifest";
import { defaultLayout, envFile, releasePath, sharedDir, workingDir, type Layout } from "./layout.ts";
import { assertIdent } from "./names.ts";
import { splitCommand, toExecStart } from "./exec.ts";

export interface RenderInput {
  app: string;
  service: string;
  def: Service;
  layout?: Layout;
  /** Unix user/group; defaults to the app name. */
  user?: string;
  instance?: string;
  /** Overrides def.port (e.g. an allocated port for a new release). */
  port?: number;
  /** Run from this release directory instead of the `current` symlink. */
  release?: string;
  /** Static, non-secret environment from the manifest. */
  environment?: Record<string, string>;
}

function line(key: string, value: string | number): string {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`illegal newline in ${key}`);
  return `${key}=${v}`;
}

export function renderUnit(input: RenderInput): string {
  const { app, service, def, instance } = input;
  const layout = input.layout ?? defaultLayout;
  const user = assertIdent("user", input.user ?? app);
  const port = input.port ?? def.port;

  const unit = [
    line("Description", `Freighter ${app}/${service}${instance ? ` (${instance})` : ""}`),
    line("X-Freighter-App", app),
    line("X-Freighter-Service", service),
    line("After", "network-online.target"),
    line("Wants", "network-online.target"),
    line("StartLimitIntervalSec", 60),
    line("StartLimitBurst", 5),
  ];

  const svc = [
    line("Type", "simple"),
    line("User", user),
    line("Group", user),
    line("WorkingDirectory", input.release ? releasePath(layout, app, input.release) : workingDir(layout, app)),
    line("ExecStart", toExecStart(splitCommand(def.command))),
  ];
  // Static env first, then the secrets file so it can override, then PORT which always wins.
  for (const [k, v] of Object.entries(input.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`invalid environment key "${k}"`);
    svc.push(line("Environment", `"${k}=${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`));
  }
  svc.push(line("EnvironmentFile", `-${envFile(layout, app)}`));
  if (port !== undefined) svc.push(line("Environment", `PORT=${port}`));

  svc.push(line("Restart", def.restart), line("RestartSec", 3));
  svc.push(line("CPUAccounting", "true"), line("MemoryAccounting", "true")); // so status can report usage

  if (def.resources?.memory) svc.push(line("MemoryMax", def.resources.memory));
  if (def.resources?.cpu !== undefined) svc.push(line("CPUQuota", `${Math.round(def.resources.cpu * 100)}%`));
  svc.push(line("TasksMax", 512));

  svc.push(
    line("NoNewPrivileges", "true"),
    line("ProtectSystem", "strict"),
    line("ProtectHome", "true"),
    line("PrivateTmp", "true"),
    line("PrivateDevices", "true"),
    line("ProtectKernelTunables", "true"),
    line("ProtectKernelModules", "true"),
    line("ProtectControlGroups", "true"),
    line("RestrictSUIDSGID", "true"),
    line("LockPersonality", "true"),
    line("ReadWritePaths", sharedDir(layout, app)),
  );

  const install = [line("WantedBy", "multi-user.target")];

  return `[Unit]\n${unit.join("\n")}\n\n[Service]\n${svc.join("\n")}\n\n[Install]\n${install.join("\n")}\n`;
}
