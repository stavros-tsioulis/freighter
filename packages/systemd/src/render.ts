import type { Service } from "@freighter/manifest";
import { containerHome, containerName, containerRuntimeDir, containerRuntimeName, defaultLayout, envFile, refsEnvFile, releasePath, sharedDir, volumeDir, workingDir, type Layout } from "./layout.ts";
import { assertIdent } from "./names.ts";
import type { Volume } from "@freighter/manifest";
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
   * Host commands only. The service is reached by HAProxy at 127.0.0.1:PORT. Sets `HOST=127.0.0.1` (below the manifest's own environment and
   * the secrets file, so either can override it), so apps that bind to `$HOST` don't end up on `localhost`, which can mean
   * only the IPv6 loopback that HAProxy never connects to.
   */
  loopback?: boolean;
  /**
   * Image services: the reference to run, normally pinned to the digest that was pulled and verified (`repo@sha256:...`).
   * Defaults to `def.image`.
   */
  image?: string;
  /**
   * Image services: the port the image listens on inside the container, when it was worked out from the image rather
   * than set in app.yaml (see `containerPorts` in core). Defaults to `def.containerPort`, then to the published port.
   */
  containerPort?: number;
  /** Image services: names of the manifest's secrets, forwarded from the unit's environment into the container. */
  secrets?: string[];
  /** Names of the attached volumes that live on another machine: the unit waits for their mounts. */
  remoteVolumes?: string[];
  /** Names of environment values that hold credentials from connections: read from the app's root-only refs file, not written here. */
  refSecrets?: string[];
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
  const argv = [PODMAN, "--cgroup-manager=cgroupfs", "run", "--rm", "--replace", "--name", containerName(app, service, instance), "--pull=never", "--cgroups=no-conmon", "--log-driver=journald",
    // User networking, with the server's loopback reachable from inside (10.0.2.2): how a
    // container gets to the published port of another service. slirp4netns is installed with Podman; the default stack varies by release.
    "--network=slirp4netns:allow_host_loopback=true"];
  if (port !== undefined) argv.push("-p", `127.0.0.1:${port}:${def.containerPort ?? input.containerPort ?? port}`);
  // Values come from the unit's environment (static env, secrets file, PORT), so they never appear on a command line.
  const keys = new Set<string>(["PORT", ...(input.secrets ?? []), ...(input.refSecrets ?? []), ...Object.keys(input.environment ?? {})]);
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

/** The unit starts after the mounts of the remote volumes it uses, and stops if they go away. */
function mountDeps(input: RenderInput, layout: Layout): string[] {
  const names = (input.remoteVolumes ?? []).filter((n) => n in (input.def.volumes ?? {})).sort();
  return names.length ? [line("RequiresMountsFor", names.map((n) => volumeDir(layout, input.app, assertIdent("volume", n))).join(" "))] : [];
}

function renderImageUnit(input: RenderInput): string {
  const { app, service, def, instance } = input;
  const layout = input.layout ?? defaultLayout;
  const user = assertIdent("user", input.user ?? app);
  const port = input.port ?? def.port;
  const name = containerName(app, service, instance);

  const unit = [
    line("Description", `Freighter ${app}/${service}${instance ? ` (${instance})` : ""}`),
    line("X-Freighter-App", app),
    line("X-Freighter-Service", service),
    line("After", "network-online.target"),
    line("Wants", "network-online.target"),
    line("StartLimitIntervalSec", 60),
    line("StartLimitBurst", 5),
    ...mountDeps(input, layout),
  ];
  const svc = [
    line("Type", "simple"),
    line("User", user),
    line("Group", user),
    line("WorkingDirectory", sharedDir(layout, app)),
    // Rootless Podman keeps its image store and runtime state under HOME / XDG_RUNTIME_DIR (the user has no real home).
    // The runtime directory is the unit's own (kept between starts, shared by the releases of one app), so no login
    // session (linger, systemd-logind, user@.service) is needed to make /run/user/<uid> exist.
    line("Environment", `HOME=${containerHome(layout, app)}`),
    line("RuntimeDirectory", containerRuntimeName(app)),
    line("RuntimeDirectoryMode", "0700"),
    line("RuntimeDirectoryPreserve", "yes"),
    line("Environment", `XDG_RUNTIME_DIR=${containerRuntimeDir(app)}`),
    // The container runs in this unit's cgroup (--cgroups=no-conmon), so the limits below bound the whole container.
    line("Delegate", "yes"),
    line("ExecStart", toExecStart(podmanRunArgv(input, port))),
    line("ExecStop", `${PODMAN} --cgroup-manager=cgroupfs stop --ignore --time 10 ${name}`),
    // A container that survived its process (a kill, a crash) keeps its name; take it away so the next start is clean.
    line("ExecStopPost", `-${PODMAN} --cgroup-manager=cgroupfs rm --force --ignore ${name}`),
  ];
  // No HOST=127.0.0.1 here (that is for host commands): inside the container the published port is reached on its own
  // network address, so an app that bound to the container's loopback would never be reachable.
  for (const [k, v] of Object.entries(input.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ENV_KEY.test(k)) throw new Error(`invalid environment key "${k}"`);
    svc.push(line("Environment", `"${k}=${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`));
  }
  svc.push(line("EnvironmentFile", `-${envFile(layout, app, service)}`));
  if (input.refSecrets?.length) svc.push(line("EnvironmentFile", `-${refsEnvFile(layout, app, service)}`));
  // PORT is the port inside the container, where an app that obeys it listens and where the published port leads.
  if (port !== undefined) svc.push(line("Environment", `PORT=${def.containerPort ?? input.containerPort ?? port}`));
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
    ...mountDeps(input, layout),
  ];

  const svc = [
    line("Type", "simple"),
    line("User", user),
    line("Group", user),
    line("WorkingDirectory", input.release ? releasePath(layout, app, input.release) : workingDir(layout, app)),
    line("ExecStart", toExecStart(splitCommand(def.command!))),
  ];
  // ProtectHome hides the user's real home, so tools that cache under $HOME (corepack and pnpm, npm, pip) get the app's
  // writable shared directory instead. Set first, so `environment:` can still override it.
  svc.push(line("Environment", `HOME=${sharedDir(layout, app)}`));
  // The loopback default next, then static env, then the secrets file so it can override, then PORT which always wins.
  if (input.loopback && port !== undefined) svc.push(line("Environment", "HOST=127.0.0.1"));
  for (const [k, v] of Object.entries(input.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`invalid environment key "${k}"`);
    svc.push(line("Environment", `"${k}=${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`));
  }
  svc.push(line("EnvironmentFile", `-${envFile(layout, app, service)}`));
  if (input.refSecrets?.length) svc.push(line("EnvironmentFile", `-${refsEnvFile(layout, app, service)}`));
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
    line("ReadWritePaths", [sharedDir(layout, app), ...Object.values(def.volumes ?? {}).sort()].join(" ")),
  );
  // Each volume the service attaches shows up at the path it asked for.
  for (const [name, path] of Object.entries(def.volumes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    svc.push(line("BindPaths", `${volumeDir(layout, app, assertIdent("volume", name))}:${path}`));
  }

  const install = [line("WantedBy", "multi-user.target")];

  return `[Unit]\n${unit.join("\n")}\n\n[Service]\n${svc.join("\n")}\n\n[Install]\n${install.join("\n")}\n`;
}

const mountEscape = (v: string) => v.replace(/\\/g, "\\\\");

/** Where the credentials of a remote volume are kept (root-only; read by mount.cifs). */
export const volumeCredentialsFile = (layout: Layout, app: string, name: string) => `${layout.envDir}/${app}/volumes/${name}.cred`;

/** The mount unit that puts a remote volume on the folder a service's volume points at. Files appear owned by the app's user. */
export function renderMountUnit(input: { app: string; name: string; volume: Volume; layout?: Layout; user?: string }): string {
  const layout = input.layout ?? defaultLayout;
  const user = assertIdent("user", input.user ?? input.app);
  const where = volumeDir(layout, input.app, assertIdent("volume", input.name));
  const v = input.volume;
  let what: string;
  let type: string;
  let options: string[];
  if (v.type === "smb") {
    what = `//${v.host}/${v.share}${v.path ? `/${v.path.replace(/^\/+|\/+$/g, "")}` : ""}`;
    type = "cifs";
    options = [`credentials=${volumeCredentialsFile(layout, input.app, input.name)}`, `uid=${user}`, `gid=${user}`, "file_mode=0660", "dir_mode=0770", "soft", "serverino", ...(v.port ? [`port=${v.port}`] : [])];
  } else {
    what = `${v.host}:${v.export}`;
    type = "nfs";
    options = [`vers=${v.version}`, "soft", "timeo=100", "retrans=2"];
  }
  return [
    "[Unit]",
    line("Description", `Freighter volume ${input.app}/${input.name}`),
    line("X-Freighter-App", input.app),
    line("After", "network-online.target"),
    line("Wants", "network-online.target"),
    "",
    "[Mount]",
    line("What", mountEscape(what)),
    line("Where", where),
    line("Type", type),
    line("Options", options.join(",")),
    line("TimeoutSec", 30),
    "",
    "[Install]",
    line("WantedBy", "multi-user.target"),
    "",
  ].join("\n");
}
