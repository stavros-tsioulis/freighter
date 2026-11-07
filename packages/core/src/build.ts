import { mkdir } from "node:fs/promises";
import { parseDuration, type Manifest } from "@freighter/manifest";
import type { Deps } from "./deps.ts";

export const buildLogPath = (d: Deps, buildId: string) => `${d.config.git.buildDir}/${buildId}.log`;
export const buildCacheDir = (d: Deps, app: string) => `${d.config.git.buildDir}/cache/${app}`;

export type BuildSpec = NonNullable<Manifest["build"]>;

/** Create the unprivileged account builds run as (idempotent). */
export async function ensureBuildUser(d: Deps): Promise<string> {
  const user = d.config.git.buildUser;
  if ((await d.run("id", ["-u", user])).code !== 0) {
    const r = await d.run("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user]);
    if (r.code !== 0) throw new Error(`useradd ${user} failed with exit code ${r.code}`);
  }
  return user;
}

/** Package-manager caches live in a per-app directory so repeat builds are fast without sharing anything between apps. */
export function buildEnv(d: Deps, app: string): Record<string, string> {
  const cache = buildCacheDir(d, app);
  return {
    HOME: `${cache}/home`,
    XDG_CACHE_HOME: `${cache}/xdg`,
    npm_config_cache: `${cache}/npm`,
    PNPM_HOME: `${cache}/pnpm`,
    YARN_CACHE_FOLDER: `${cache}/yarn`,
    CI: "1",
    NODE_ENV: "development", // build tools (pnpm/npm install) need their dev dependencies
  };
}

/** Arguments for `systemd-run` that confine a build. Exported so the exact sandbox is reviewable and testable. */
export function sandboxArgs(d: Deps, o: { app: string; buildId: string; dir: string; spec: BuildSpec }): string[] {
  const user = d.config.git.buildUser;
  const cache = buildCacheDir(d, o.app);
  const props: Record<string, string> = {
    MemoryMax: o.spec.memory,
    CPUQuota: `${Math.round(o.spec.cpu * 100)}%`,
    TasksMax: "1024",
    RuntimeMaxSec: String(Math.ceil(parseDuration(o.spec.timeout) / 1000)),
    PrivateTmp: "yes",
    PrivateDevices: "yes",
    ProtectSystem: "strict",
    ProtectHome: "yes",
    NoNewPrivileges: "yes",
    ProtectKernelTunables: "yes",
    ProtectKernelModules: "yes",
    ProtectControlGroups: "yes",
    RestrictSUIDSGID: "yes",
    ReadWritePaths: `${o.dir} ${cache}`,
    // Everything a build has no business seeing: other apps, secrets, deploy keys, the agent socket, proxy config.
    InaccessiblePaths: ["/srv/apps", "/etc/freighter", d.config.git.keyDir, "/var/lib/freighter", "/run/freighter", "/etc/haproxy", "/etc/letsencrypt"]
      .map((p) => `-${p}`)
      .join(" "),
  };
  const env = buildEnv(d, o.app);
  return [
    "--quiet", "--wait", "--pipe", "--collect",
    `--unit=freighter-build-${o.buildId.slice(0, 8)}`,
    `--uid=${user}`,
    `--gid=${user}`,
    `--working-directory=${o.dir}`,
    ...Object.entries(props).map(([k, v]) => `--property=${k}=${v}`),
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
  ];
}

export interface BuildResult {
  ok: boolean;
  code: number;
  timedOut: boolean;
  seconds: number;
}

/**
 * Run the manifest's build commands in `dir`. On a real server that is a transient, sandboxed, resource-limited
 * systemd unit under the build user; under --prefix (no systemd) the script runs directly and unsandboxed.
 */
export async function runBuild(d: Deps, o: { app: string; buildId: string; dir: string; spec: BuildSpec }): Promise<BuildResult> {
  const started = Date.now();
  const script = ["set -e", ...o.spec.commands].join("\n");
  const timeoutMs = parseDuration(o.spec.timeout);
  const logFile = buildLogPath(d, o.buildId);
  await mkdir(buildCacheDir(d, o.app), { recursive: true });

  let r: { code: number; timedOut: boolean };
  if (d.dev) {
    r = await d.runLogged("sh", ["-ec", script], { logFile, cwd: o.dir, env: buildEnv(d, o.app), timeoutMs });
  } else {
    const user = d.config.git.buildUser;
    await d.run("chown", ["-R", `${user}:${user}`, buildCacheDir(d, o.app)]);
    // +30 s: let systemd's own RuntimeMaxSec fire first so the unit is cleaned up properly.
    r = await d.runLogged("systemd-run", [...sandboxArgs(d, o), "/bin/sh", "-ec", script], { logFile, timeoutMs: timeoutMs + 30_000 });
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const timedOut = r.timedOut || (r.code !== 0 && Date.now() - started >= timeoutMs);
  return { ok: r.code === 0, code: r.code, timedOut, seconds };
}
