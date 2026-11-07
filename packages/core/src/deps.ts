import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createHaproxy, ensureCert, type Haproxy } from "@freighter/haproxy";
import { createSystemd, defaultLayout, defaultRun, type Layout, type Run, type Systemd } from "@freighter/systemd";
import { HOST_CONFIG_PATH, loadConfig, type HostConfig } from "./config.ts";

export interface Deps {
  layout: Layout;
  systemd: Systemd;
  haproxy: Haproxy;
  config: HostConfig;
  /** Where `config` was read from (and where the settings UI writes it back). Default: /etc/freighter/config.yaml. */
  configPath?: string;
  /** Runs host commands that change the machine (id, useradd, chown, systemctl, certbot, haproxy). A no-op under --prefix. */
  run: Run;
  /** Always runs for real, even under --prefix: read-mostly tools such as git, ssh-keygen and tar. */
  exec: Run;
  /** Run a command with combined output streamed to a (size-capped) log file. Always real. */
  runLogged: (cmd: string, args: string[], o: { logFile: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; timedOut: boolean }>;
  now: () => Date;
  isRoot: boolean;
  /** Dev/prefix mode: nothing real runs, so certificates are skipped. */
  dev: boolean;
  sleep: (ms: number) => Promise<void>;
  /** HTTP GET; resolves to the status code, or null on connection failure/timeout. */
  probe: (url: string, timeoutMs: number) => Promise<number | null>;
  portFree: (port: number) => Promise<boolean>;
  /** Make sure a certificate for `hostname` exists and is fresh. */
  issueCert: (hostname: string, opts?: { force?: boolean }) => Promise<{ issued: boolean; expires: Date | null }>;
}

const LOG_CAP = 1024 * 1024;

export const runLogged: Deps["runLogged"] = (cmd, args, o) =>
  new Promise((resolve) => {
    const out = createWriteStream(o.logFile, { flags: "a", mode: 0o644 });
    let written = 0;
    let truncated = false;
    const write = (chunk: Buffer) => {
      if (written >= LOG_CAP) {
        if (!truncated) out.write("\n[log truncated]\n");
        truncated = true;
        return;
      }
      written += chunk.length;
      out.write(chunk);
    };
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ? { ...process.env, ...o.env } : process.env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, o.timeoutMs)
      : undefined;
    child.stdout.on("data", write);
    child.stderr.on("data", write);
    child.on("error", (e) => {
      write(Buffer.from(`failed to start ${cmd}: ${e.message}\n`));
      clearTimeout(timer);
      out.end(() => resolve({ code: 127, timedOut: false }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => resolve({ code: code ?? 1, timedOut }));
    });
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const probe: Deps["probe"] = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
};

const portFree: Deps["portFree"] = (port) =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

/**
 * With `prefix`, all paths are relocated under it and host commands become no-ops,
 * so the whole flow can be exercised without root or systemd (e.g. on macOS).
 */
export async function defaultDeps(opts: { prefix?: string } = {}): Promise<Deps> {
  const prefix = opts.prefix ? resolve(opts.prefix) : "";
  const layout: Layout = prefix
    ? { appsRoot: prefix + defaultLayout.appsRoot, envDir: prefix + defaultLayout.envDir, unitDir: prefix + defaultLayout.unitDir }
    : defaultLayout;
  const config = await loadConfig(prefix || undefined);
  const run: Run = prefix ? async () => ({ stdout: "", code: 0 }) : defaultRun;
  const deps: Deps = {
    layout,
    config,
    configPath: prefix + HOST_CONFIG_PATH,
    run,
    exec: defaultRun,
    runLogged,
    systemd: createSystemd({ run, layout }),
    haproxy: createHaproxy({ run, config: config.haproxy }),
    now: () => new Date(),
    isRoot: prefix ? true : process.getuid?.() === 0,
    dev: Boolean(prefix),
    sleep: prefix ? async () => {} : sleep, // no real waiting (drain etc.) in dev mode
    probe,
    portFree: prefix ? async () => true : portFree,
    issueCert: async (hostname, o) =>
      prefix
        ? { issued: false, expires: null }
        : ensureCert({ hostname, dir: config.haproxy.dir, acme: config.acme, run, now: () => deps.now(), force: o?.force }),
  };
  return deps;
}
