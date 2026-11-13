import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { stopIfCanceled } from "./operations.ts";
import { containerHome, containerRuntimeDir, volumeDir, PODMAN } from "@freighter/systemd";
import { imageServices, type Manifest } from "@freighter/manifest";
import { chownShared } from "./app.ts";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { listReleaseIds, releaseDir } from "./releases.ts";

/** Credentials for one registry, used for a single pull and never written anywhere that outlives it. */
export interface RegistryAuth {
  host: string;
  username: string;
  password: string;
}

export { imageHost, imageServices } from "@freighter/manifest";
import { imageHost } from "@freighter/manifest";

const IMAGES_FILE = ".freighter-images.json";
const SUBID_COUNT = 65536;
const SUBID_FIRST = 100000;

/** Pinned references (`repo@sha256:...`) of a release's image services, as resolved when it was deployed. */
export async function readImages(d: Deps, app: string, release: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(`${releaseDir(d, app, release)}/${IMAGES_FILE}`, "utf8")) as Record<string, string>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function writeImages(d: Deps, app: string, release: string, images: Record<string, string>): Promise<void> {
  await writeFile(`${releaseDir(d, app, release)}/${IMAGES_FILE}`, JSON.stringify(images, null, 2));
}

/** Whether this host can run images (Podman is installed). Always true under --prefix, where nothing real runs. */
export async function containersAvailable(d: Deps): Promise<{ available: boolean; version?: string }> {
  if (d.dev) return { available: true, version: "dev" };
  try {
    const r = await d.run(PODMAN, ["--version"]);
    return r.code === 0 ? { available: true, version: r.stdout.trim().replace(/^podman version\s*/i, "") } : { available: false };
  } catch {
    return { available: false };
  }
}

export const NO_CONTAINERS_MESSAGE =
  "this server cannot run images: Podman is not installed (re-run the installer with FREIGHTER_WITH_CONTAINERS=1, or install podman, uidmap and passt)";

/**
 * Run podman as the app's user (rootless), with its own HOME and runtime directory. It runs in a transient unit of its
 * own rather than as a child of the agent: the first rootless podman of a user leaves a helper process behind that
 * holds its namespaces, and containers started later join it. Started from the agent, that would be the agent's sandbox
 * (a private /tmp), and the containers' network helper could not mount its own /tmp in it. The unit ends with the command,
 * and takes the helper with it.
 */
async function podman(d: Deps, app: string, args: string[], timeoutMs?: number, signal?: AbortSignal) {
  const home = containerHome(d.layout, app);
  const unit = `freighter-podman-${app}-${randomBytes(4).toString("hex")}`;
  const env = [`HOME=${home}`, `TMPDIR=${home}/tmp`, `XDG_RUNTIME_DIR=${containerRuntimeDir(app)}`];
  const stop = () => void d.run("systemctl", ["stop", `${unit}.service`]).catch(() => undefined);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    return await d.run(
      "systemd-run",
      [
        "--quiet", "--wait", "--pipe", "--collect",
        `--unit=${unit}`, `--uid=${app}`, `--gid=${app}`, `--working-directory=${home}`,
        ...(timeoutMs ? [`--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`] : []),
        ...env.map((e) => `--setenv=${e}`),
        PODMAN, "--cgroup-manager=cgroupfs", ...args,
      ],
      { timeoutMs: timeoutMs ? timeoutMs + 30_000 : undefined, signal },
    );
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

async function nextFreeSubidStart(file: string): Promise<number> {
  const text = await readFile(file, "utf8").catch(() => "");
  let next = SUBID_FIRST;
  for (const line of text.split("\n")) {
    const [, start, count] = line.split(":");
    if (start && count) next = Math.max(next, Number(start) + Number(count));
  }
  return next;
}

/**
 * Everything rootless Podman needs for this app's user: a subordinate uid/gid range, a private runtime directory
 * (units create it themselves; this makes it exist for pulls before any unit has started), a home for the image store,
 * and the service volumes. No login session is involved, so it works where systemd-logind is absent. Idempotent. Runs under the deploy lock,
 * which also keeps two deploys from picking the same subuid range.
 */
export async function ensureContainerRuntime(d: Deps, app: string, manifest: Pick<Manifest, "services">): Promise<void> {
  const home = containerHome(d.layout, app);
  await mkdir(home, { recursive: true });
  await mkdir(`${home}/tmp`, { recursive: true }); // where podman unpacks a pulled image; the host's /var/tmp may not exist
  for (const s of Object.values(manifest.services)) {
    for (const name of Object.keys(s.volumes ?? {})) await mkdir(volumeDir(d.layout, app, name), { recursive: true });
  }
  if (!d.dev) {
    const subuids = await readFile("/etc/subuid", "utf8").catch(() => "");
    if (!subuids.split("\n").some((l) => l.startsWith(`${app}:`))) {
      const start = await nextFreeSubidStart("/etc/subuid");
      const gidStart = Math.max(start, await nextFreeSubidStart("/etc/subgid"));
      const r = await d.run("usermod", ["--add-subuids", `${start}-${start + SUBID_COUNT - 1}`, "--add-subgids", `${gidStart}-${gidStart + SUBID_COUNT - 1}`, app]);
      if (r.code !== 0) throw new Error(`could not allocate subordinate ids for ${app} (usermod exit code ${r.code})`);
    }
  }
  // Owned by the app's user and private to it, like the directory the units create (see containerRuntimeDir).
  await d.run("install", ["-d", "-o", app, "-g", app, "-m", "0700", containerRuntimeDir(app)]);
  // Not recursive in the home: its image store holds files owned by the mapped ids of the images, which a chown would undo.
  await d.run("chown", [`${app}:${app}`, home, `${home}/tmp`]);
  await chownShared(d, app);
}

const PORTS_FILE = ".freighter-container-ports.json";

/** Ports the images of a release were found to listen on (service -> port), for services that did not set `containerPort`. */
export async function readContainerPorts(d: Deps, app: string, release: string): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(`${releaseDir(d, app, release)}/${PORTS_FILE}`, "utf8")) as Record<string, number>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
export async function writeContainerPorts(d: Deps, app: string, release: string, ports: Record<string, number>): Promise<void> {
  if (Object.keys(ports).length > 0) await writeFile(`${releaseDir(d, app, release)}/${PORTS_FILE}`, JSON.stringify(ports, null, 2));
}

/** The TCP ports an image declares with EXPOSE (sorted). */
async function exposedPorts(d: Deps, app: string, ref: string): Promise<number[]> {
  const r = await podman(d, app, ["image", "inspect", "--format", "{{json .Config.ExposedPorts}}", ref]);
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim() || "null") as Record<string, unknown> | null;
    const ports = Object.keys(parsed ?? {}).flatMap((k) => {
      const m = /^(\d+)(?:\/tcp)?$/.exec(k);
      return m ? [Number(m[1])] : [];
    });
    return [...new Set(ports)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export interface PullResult {
  /** service -> pinned reference (`repo@sha256:...`), or the reference as written when the digest cannot be known (dev mode). */
  images: Record<string, string>;
  /** service -> the port its image declares (EXPOSE), for image services that set no `containerPort` and whose image names exactly one. */
  containerPorts: Record<string, number>;
}

/**
 * Pull the images of a manifest as the app's user and resolve each to the digest that was pulled, so the release runs
 * exactly that content no matter what the tag points to later.
 */
export async function pullImages(d: Deps, app: string, manifest: Pick<Manifest, "services">, opts: { auth?: RegistryAuth[]; log?: DeployLog; signal?: AbortSignal } = {}): Promise<PullResult> {
  const log = opts.log ?? noLog;
  const wanted = imageServices(manifest);
  const images: Record<string, string> = {};
  const containerPorts: Record<string, number> = {};
  const pulled = new Map<string, string>();
  const exposed = new Map<string, number[]>();
  const authFile = `${containerHome(d.layout, app)}/auth-${process.pid}-${d.now().getTime()}.json`;

  /**
   * Without `containerPort` the image's own EXPOSE says where it listens: most images (Grafana, nginx, Postgres...)
   * ignore $PORT, so publishing onto "the same port" would reach nothing. One declared port is used; zero or several
   * are said out loud, and the published port is used as before.
   */
  const resolvePort = async (service: string, ref: string) => {
    const def = manifest.services[service]!;
    if (def.containerPort !== undefined) return;
    if (!exposed.has(ref)) exposed.set(ref, await exposedPorts(d, app, ref));
    const ports = exposed.get(ref)!;
    if (ports.length === 1) {
      containerPorts[service] = ports[0]!;
      await log(`    ${service} listens on ${ports[0]} (the port the image declares; set containerPort to override)`);
    } else if (ports.length > 1) {
      await log(`    warning: the image of ${service} declares ports ${ports.join(", ")}; set containerPort to say which one to publish (using $PORT for now)`);
    } else if (!d.dev) {
      await log(`    note: the image of ${service} declares no port; it has to listen on $PORT, or set containerPort`);
    }
  };

  try {
    for (const [service, ref] of Object.entries(wanted)) {
      const done = pulled.get(ref);
      if (done !== undefined) {
        images[service] = done;
        await resolvePort(service, ref);
        continue;
      }
      const args = ["pull", "--quiet"];
      const login = opts.auth?.find((a) => a.host === imageHost(ref));
      if (login) {
        const token = Buffer.from(`${login.username}:${login.password}`).toString("base64");
        await writeFile(authFile, JSON.stringify({ auths: { [login.host]: { auth: token } } }), { mode: 0o600 });
        await chmod(authFile, 0o600);
        await d.run("chown", [`${app}:${app}`, authFile]);
        args.push("--authfile", authFile);
      }
      await log(`==> pulling ${ref} (for ${service})`);
      stopIfCanceled(opts.signal);
      const r = await podman(d, app, [...args, ref], 15 * 60_000, opts.signal);
      if (r.code !== 0) {
        const why = (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
        throw new Error(`pulling ${ref} failed (exit code ${r.code})${why ? `: ${why}` : ""}`);
      }
      const inspect = await podman(d, app, ["image", "inspect", "--format", "{{index .RepoDigests 0}}", ref]);
      const pinned = inspect.stdout.trim();
      if (inspect.code === 0 && /^[^\s]+@sha256:[a-f0-9]{64}$/.test(pinned)) {
        await log(`    ${pinned}`);
        pulled.set(ref, pinned);
        images[service] = pinned;
      } else if (d.dev) {
        pulled.set(ref, ref);
        images[service] = ref;
      } else {
        throw new Error(`could not resolve the digest of ${ref}`);
      }
      await resolvePort(service, ref);
    }
  } finally {
    await rm(authFile, { force: true });
  }
  return { images, containerPorts };
}

/**
 * Remove images that no remaining release refers to. Best effort: an image that is still in use, or shared with another
 * tag, simply stays. Called after old releases are pruned.
 */
export async function pruneImages(d: Deps, app: string): Promise<string[]> {
  const referenced = new Set<string>();
  for (const id of await listReleaseIds(d, app)) for (const ref of Object.values(await readImages(d, app, id))) referenced.add(ref);
  const listed = await podman(d, app, ["images", "--no-trunc", "--format", "{{.ID}} {{.Repository}}@{{.Digest}}"]);
  if (listed.code !== 0) return [];
  const removed: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const [id, ref] = line.trim().split(" ");
    if (!id || !ref || referenced.has(ref)) continue;
    const r = await podman(d, app, ["rmi", id]);
    if (r.code === 0) removed.push(ref);
  }
  return removed;
}

/** Remove every container and image the app's user owns (part of deleting the app). */
export async function removeContainers(d: Deps, app: string): Promise<void> {
  if ((await d.run("id", ["-u", app])).code !== 0) return;
  await podman(d, app, ["rm", "--all", "--force", "--ignore"]).catch(() => undefined);
  await podman(d, app, ["system", "reset", "--force"]).catch(() => undefined);
  await d.run("rm", ["-rf", containerRuntimeDir(app)]).catch(() => undefined);
}
