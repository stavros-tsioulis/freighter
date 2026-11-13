import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHaproxy } from "@freighter/haproxy";
import { createSystemd, type Run } from "@freighter/systemd";
import { defaultRun } from "@freighter/systemd";
import { parseHostConfig, runLogged, type Deps } from "../src/index.ts";

/**
 * Fake host. The artifact decides how a "service" behaves, found via its unit file's WorkingDirectory:
 *  - a file named BAD in the release makes health probes return 500
 *  - a file named CRASH makes the unit report NRestarts=1
 */
export async function makeDeps(opts: { isRoot?: boolean; config?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "freighter-core-"));
  const layout = { appsRoot: `${root}/srv/apps`, envDir: `${root}/etc/apps`, unitDir: `${root}/etc/systemd` };
  const config = parseHostConfig({
    haproxy: { dir: `${root}/etc/haproxy`, mainConfig: `${root}/etc/haproxy.cfg` },
    acme: { email: "me@example.com" },
    ports: { min: 20000, max: 20009 },
    git: { allowLocal: true, buildDir: `${root}/var/build`, keyDir: `${root}/var/git` },
    ...(opts.config as object),
  });
  const calls: string[][] = [];
  const created = new Set<string>();
  const probed: string[] = [];
  const ctl = { rclone: { version: "rclone v1.68.2" as string | null, lsdCode: 0, lsdStderr: "", keyscan: "" }, podman: { installed: true, failPull: false, digest: "a".repeat(64), images: [] as string[], exposed: [] as number[] }, haproxyCheckCode: 0, busyPorts: new Set<number>(), issued: [] as string[], failIssue: false, ufw: { installed: true, active: false, sshd: "port 22\n", rules: [] as { to: string; action: string; direction: string; from: string; comment: string; v6: boolean }[], defaults: { incoming: "deny", outgoing: "allow" } } };

  const unitFiles = () => (existsSync(layout.unitDir) ? readdirSync(layout.unitDir).filter((f) => f.endsWith(".service")) : []);
  const unitText = (unit: string) => (existsSync(`${layout.unitDir}/${unit}`) ? readFileSync(`${layout.unitDir}/${unit}`, "utf8") : "");
  const releaseOf = (text: string) => /^WorkingDirectory=(.*)$/m.exec(text)?.[1];
  const flagged = (text: string, flag: string) => {
    const wd = releaseOf(text);
    return wd !== undefined && existsSync(`${wd}/${flag}`);
  };

  const run: Run = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "/usr/local/bin/rclone" && args[0] === "version") return ctl.rclone.version ? { stdout: `${ctl.rclone.version}\n- os/version: debian\n`, code: 0 } : { stdout: "", code: 127 };
    if (cmd === "/usr/local/bin/rclone" && args[0] === "lsd") return { stdout: "", stderr: ctl.rclone.lsdStderr, code: ctl.rclone.lsdCode };
    if (cmd === "sh" && args.some((a) => a.includes("rclone obscure"))) return { stdout: `obscured(${opts?.env?.FR_PW})\n`, code: 0 };
    if (cmd === "ssh-keyscan") return { stdout: ctl.rclone.keyscan, code: 0 };
    if (cmd === "sh" && args.some((a) => a.includes("command -v ufw"))) return { stdout: "", code: ctl.ufw.installed ? 0 : 1 };
    if (cmd === "sshd") return { stdout: ctl.ufw.sshd, code: 0 };
    if (cmd === "ufw") return fakeUfw(ctl.ufw, args);
    if (cmd === "useradd") created.add(args.at(-1)!);
    if (cmd === "id") return created.has(args.at(-1)!) ? { stdout: "1001\n", code: 0 } : { stdout: "", code: 1 }; // the app user exists once useradd ran
    if (cmd === "/usr/bin/podman") return ctl.podman.installed ? { stdout: "podman version 5.0.0\n", code: 0 } : { stdout: "", code: 127 };
    if (cmd === "systemd-run" && args.includes("/usr/bin/podman")) {
      const args2 = args.slice(args.indexOf("/usr/bin/podman") + 1).filter((a) => !a.startsWith("--cgroup-manager"));
      if (args2[0] === "pull") return ctl.podman.failPull ? { stdout: "", stderr: "manifest unknown\n", code: 125 } : { stdout: "", code: 0 };
      if (args2[0] === "image" && args2[1] === "inspect" && args2.some((a) => a.includes("ExposedPorts"))) {
        return { stdout: `${ctl.podman.exposed.length ? JSON.stringify(Object.fromEntries(ctl.podman.exposed.map((p) => [`${p}/tcp`, {}]))) : "null"}\n`, code: 0 };
      }
      if (args2[0] === "image" && args2[1] === "inspect") return { stdout: `${args2.at(-1)!.replace(/[:@].*$/, "")}@sha256:${ctl.podman.digest}\n`, code: 0 };
      if (args2[0] === "images") return { stdout: ctl.podman.images.join("\n"), code: 0 };
      return { stdout: "", code: 0 };
    }
    if (cmd === "systemctl" && args[0] === "show") {
      const restarts = flagged(unitText(args.at(-1)!), "CRASH") ? 1 : 0;
      return { stdout: `ActiveState=active\nSubState=running\nMainPID=1\nMemoryCurrent=1024\nNRestarts=${restarts}\nCPUUsageNSec=2000000000\n`, code: 0 };
    }
    if (cmd === "journalctl") return { stdout: "boom: something broke\n", code: 0 };
    if (cmd === "haproxy") return { stdout: "", stderr: "[ALERT] invalid config", code: ctl.haproxyCheckCode };
    return { stdout: "", code: 0 };
  };
  let tick = 0;
  const deps: Deps = {
    layout,
    config,
    run,
    exec: defaultRun,
    runLogged,
    systemd: createSystemd({ run, layout }),
    haproxy: createHaproxy({ run, config: config.haproxy }),
    now: () => new Date(Date.UTC(2026, 10, 6, 13, 45, tick++)),
    isRoot: opts.isRoot ?? true,
    dev: false,
    sleep: async () => {},
    probe: async (url) => {
      probed.push(url);
      const port = /:(\d+)\//.exec(url)?.[1];
      const unit = unitFiles().find((u) => unitText(u).includes(`Environment=PORT=${port}\n`));
      return unit && flagged(unitText(unit), "BAD") ? 500 : 200;
    },
    portFree: async (p) => !ctl.busyPorts.has(p),
    lockWaitMs: 0, // tests that exercise waiting set their own
    pickPort: (min) => min, // tests want the lowest free port, not a random one
    issueCert: async (hostname) => {
      if (ctl.failIssue) throw new Error(`certbot failed for ${hostname}`);
      ctl.issued.push(hostname);
      return { issued: true, expires: null };
    },
  };
  /** Calls minus the read-only `systemctl show` polling. */
  const mutating = () => calls.filter((c) => !(c[0] === "systemctl" && c[1] === "show"));
  const haproxyFile = (name: string) => (existsSync(`${config.haproxy.dir}/${name}`) ? readFileSync(`${config.haproxy.dir}/${name}`, "utf8") : null);
  return { root, deps, calls, mutating, probed, ctl, unitFiles, unitText, haproxyFile };
}

export async function artifact(files: Record<string, string> = { "server.mjs": "// web\n" }) {
  const dir = await mkdtemp(join(tmpdir(), "freighter-art-"));
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

export const MANIFEST = `name: hello
services:
  web:
    command: node server.mjs
    port: 3100
    environment:
      GREETING: hi
    secrets:
      - TOKEN
  worker:
    command: node worker.mjs
    environment:
      GREETING: hi
`;

/** web has a healthcheck; no worker. */
export const HC_MANIFEST = `name: hello
services:
  web:
    command: node server.mjs
    port: 3100
    healthcheck:
      path: /health
      timeout: 5s
releases:
  keep: 2
`;

/** A routed app: web is served on shop.example.com, worker is in place. */
export const routedManifest = (name = "shop") => `name: ${name}
services:
  web:
    command: node server.mjs
    healthcheck:
      path: /health
      timeout: 5s
  worker:
    command: node worker.mjs
`;

/** The same app with its domain, as options for deploy() / app.deploy (domains are not part of app.yaml). */
export const routed = (name = "shop", host = "shop.example.com", tls: "auto" | "off" = "auto") => ({
  manifestText: routedManifest(name),
  domains: [{ hostname: host, service: "web", tls }],
});

/** Enough of ufw to read and change rules: the same output formats, the same arguments. */
function fakeUfw(u: { installed: boolean; active: boolean; rules: { to: string; action: string; direction: string; from: string; comment: string; v6: boolean }[]; defaults: { incoming: string; outgoing: string } }, args: string[]): { stdout: string; stderr?: string; code: number } {
  const a = args[0] === "--force" ? args.slice(1) : args;
  if (a[0] === "status" && a[1] === "verbose") {
    return { stdout: u.active ? `Status: active\nLogging: on (low)\nDefault: ${u.defaults.incoming} (incoming), ${u.defaults.outgoing} (outgoing), disabled (routed)\nNew profiles: skip\n` : "Status: inactive\n", code: 0 };
  }
  if (a[0] === "status" && a[1] === "numbered") {
    if (!u.active) return { stdout: "Status: inactive\n", code: 0 };
    const lines = u.rules.map((r, i) => `[${String(i + 1).padStart(2)}] ${(r.to + (r.v6 ? " (v6)" : "")).padEnd(26)}  ${`${r.action.toUpperCase()} ${r.direction.toUpperCase()}`.padEnd(11)}  ${r.from}${r.v6 ? " (v6)" : ""}${r.comment ? `  # ${r.comment}` : ""}`);
    return { stdout: `Status: active\n\n     To                         Action      From\n     --                         ------      ----\n${lines.join("\n")}\n`, code: 0 };
  }
  if (a[0] === "enable") {
    u.active = true;
    return { stdout: "Firewall is active and enabled on system startup\n", code: 0 };
  }
  if (a[0] === "disable") {
    u.active = false;
    return { stdout: "Firewall stopped and disabled on system startup\n", code: 0 };
  }
  if (a[0] === "default") {
    u.defaults[a[2] as "incoming" | "outgoing"] = a[1]!;
    return { stdout: "Default policy changed\n", code: 0 };
  }
  if (a[0] === "delete") {
    const n = Number(a[1]);
    if (!u.rules[n - 1]) return { stdout: "", stderr: "ERROR: Could not find rule\n", code: 1 };
    u.rules.splice(n - 1, 1);
    return { stdout: "Rule deleted\n", code: 0 };
  }
  let at: number | undefined;
  let b = a;
  if (b[0] === "insert") {
    at = Number(b[1]);
    b = b.slice(2);
  }
  if (["allow", "deny", "reject", "limit"].includes(b[0]!)) {
    const get = (k: string) => b[b.indexOf(k) + 1];
    const has = (k: string) => b.includes(k);
    const port = has("port") ? get("port") : undefined;
    const proto = has("proto") ? get("proto") : undefined;
    const to = port ? `${port}${proto ? `/${proto}` : ""}` : get("to") === "any" ? "Anywhere" : get("to")!;
    const from = get("from") === "any" ? "Anywhere" : get("from")!;
    const base = { to, action: b[0]!, direction: b[1] === "out" ? "out" : "in", from, comment: has("comment") ? get("comment")! : "" };
    const twins = from === "Anywhere" && (get("to") === "any" || !!port) ? [{ ...base, v6: false }, { ...base, v6: true }] : [{ ...base, v6: false }];
    u.rules.splice(at ? at - 1 : u.rules.length, 0, ...twins);
    return { stdout: "Rule added\n", code: 0 };
  }
  return { stdout: "", stderr: `ERROR: unknown ufw command ${a.join(" ")}\n`, code: 1 };
}
