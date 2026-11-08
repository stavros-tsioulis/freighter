import type { Service } from "@freighter/manifest";
import { containerHome, containerName, defaultLayout, envFile, releasePath, sharedDir, volumeDir, workingDir, type Layout } from "./layout.ts";
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
  /**
   * The service is reached by HAProxy at 127.0.0.1:PORT. Sets `HOST=127.0.0.1` (below the manifest's own environment and
   * the secrets file, so either can override it), so apps that bind to `$HOST` don't end up on `localhost`, which can mean
   * only the IPv6 loopback that HAProxy never connects to.
   */
  loopback?: boolean;
  /**
   * Image services: the reference to run, normally pinned to the digest that was pulled and verified (`repo@sha256:...`).
   * Defaults to `def.image`.
   */
  image?: string;
  /** Image services: the numeric id of the unit's user (rootless Podman keeps its runtime state in /run/user/<uid>). */
  uid?: number;
  /** Image services: names of the manifest's secrets, forwarded from the unit's environment into the container. */
  secrets?: string[];
}

/** Path of the container runtime. systemd needs an absolute path. */
export const PODMAN = "/usr/bin/podman";

function line(key: string, value: string | number): string {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`illegal newline in ${key}`);
  return `${key}=${v}`;
}

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

/** The `podman run` command line (argv) for an image service. */
export function podmanRunArgv(input: RenderInput, port: number | undefined): string[] {
  const { app, service, def, instance } = input;
  const layout = input.layout ?? defaultLayout;
  const image = input.image ?? def.image;
  if (image === undefined) throw new Error(`service ${service} has no image`);
  if (!/^[^\s"'\\;$%]+$/.test(image)) throw new Error(`illegal image reference "${image}"`);
  // cgroupfs rather than systemd: the app's user has no systemd user bus, and the unit's own cgroup is delegated to it.
  const argv = [PODMAN, "--cgroup-manager=cgroupfs", "run", "--rm", "--name", containerName(app, service, instance), "--pull=never", "--cgroups=no-conmon", "--log-driver=journald"];
  if (port !== undefined) argv.push("-p", `127.0.0.1:${port}:${def.containerPort ?? port}`);
  // Values come from the unit's environment (static env, secrets file, PORT), so they never appear on a command line.
  const keys = new Set<string>(["PORT", ...(input.secrets ?? []), ...Object.keys(input.environment ?? {})]);
  if (input.loopback && port !== undefined) keys.add("HOST");
  if (port === undefined) keys.delete("PORT");
  for (const k of [...keys].sort()) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid environment key "${k}"`);
    argv.push("-e", k);
  }
  for (const [name, path] of Object.entries(def.volumes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("-v", `${volumeDir(layout, app, assertIdent("volume", name))}:${path}:Z`);
  }
  argv.push(image);
  return argv;
}

function renderImageUnit(input: RenderInput): string {
  const { app, service, def, instance } = input;
  const layout = input.layout ?? defaultLayout;
  const user = assertIdent("user", input.user ?? app);
  const port = input.port ?? def.port;
  const name = containerName(app, service, instance);
  const uid = input.uid;
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) throw new Error(`service ${service}: the user id of ${user} is needed to render an image unit`);

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
    line("WorkingDirectory", sharedDir(layout, app)),
    // Rootless Podman keeps its image store and runtime state under HOME / XDG_RUNTIME_DIR (the user has no real home).
    line("Environment", `HOME=${containerHome(layout, app)}`),
    // (not %U: in a system unit that is the manager's uid, root)
    line("Environment", `XDG_RUNTIME_DIR=/run/user/${uid}`),
    // The container runs in this unit's cgroup (--cgroups=no-conmon), so the limits below bound the whole container.
    line("Delegate", "yes"),
    line("ExecStart", toExecStart(podmanRunArgv(input, port))),
    line("ExecStop", `${PODMAN} --cgroup-manager=cgroupfs stop --ignore --time 10 ${name}`),
  ];
  if (input.loopback && port !== undefined) svc.push(line("Environment", "HOST=127.0.0.1"));
  for (const [k, v] of Object.entries(input.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid environment key "${k}"`);
    svc.push(line("Environment", `"${k}=${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`));
  }
  svc.push(line("EnvironmentFile", `-${envFile(layout, app)}`));
  if (port !== undefined) svc.push(line("Environment", `PORT=${port}`));
  svc.push(line("Restart", def.restart), line("RestartSec", 3), line("TimeoutStopSec", 20));
  svc.push(line("CPUAccounting", "true"), line("MemoryAccounting", "true"));
  if (def.resources?.memory) svc.push(line("MemoryMax", def.resources.memory));
  if (def.resources?.cpu !== undefined) svc.push(line("CPUQuota", `${Math.round(def.resources.cpu * 100)}%`));
  svc.push(line("TasksMax", 2048));
  // No NoNewPrivileges / ProtectSystem / PrivateDevices etc.: rootless Podman needs the setuid newuidmap helpers and
  // manages its own namespaces. The container is the sandbox.
  svc.push(line("LockPersonality", "true"), line("ProtectKernelModules", "true"));

  return `[Unit]\n${unit.join("\n")}\n\n[Service]\n${svc.join("\n")}\n\n[Install]\n${line("WantedBy", "multi-user.target")}\n`;
}

export function renderUnit(input: RenderInput): string {
  if (input.def.image !== undefined) return renderImageUnit(input);
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
    line("ExecStart", toExecStart(splitCommand(def.command!))),
  ];
  // The loopback default first, then static env, then the secrets file so it can override, then PORT which always wins.
  if (input.loopback && port !== undefined) svc.push(line("Environment", "HOST=127.0.0.1"));
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
