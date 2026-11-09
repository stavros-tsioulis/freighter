import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { containerHome, containerRuntimeDir, volumeDir, PODMAN } from "@freighter/systemd";
import { imageServices, type Manifest } from "@freighter/manifest";
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

/** Run podman as the app's user (rootless), with its own HOME and runtime directory. */
async function podman(d: Deps, app: string, args: string[], timeoutMs?: number) {
  return d.run(
    "runuser",
    ["-u", app, "--", "env", `HOME=${containerHome(d.layout, app)}`, `XDG_RUNTIME_DIR=${containerRuntimeDir(app)}`, PODMAN, "--cgroup-manager=cgroupfs", ...args],
    { timeoutMs },
  );
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
  await d.run("chown", ["-R", `${app}:${app}`, home, `${d.layout.appsRoot}/${app}/shared`]);
}

export interface PullResult {
  /** service -> pinned reference (`repo@sha256:...`), or the reference as written when the digest cannot be known (dev mode). */
  images: Record<string, string>;
}

/**
 * Pull the images of a manifest as the app's user and resolve each to the digest that was pulled, so the release runs
 * exactly that content no matter what the tag points to later.
 */
export async function pullImages(d: Deps, app: string, manifest: Pick<Manifest, "services">, opts: { auth?: RegistryAuth[]; log?: DeployLog } = {}): Promise<PullResult> {
  const log = opts.log ?? noLog;
  const wanted = imageServices(manifest);
  const images: Record<string, string> = {};
  const pulled = new Map<string, string>();
  const authFile = `${containerHome(d.layout, app)}/auth-${process.pid}-${d.now().getTime()}.json`;

  try {
    for (const [service, ref] of Object.entries(wanted)) {
      const done = pulled.get(ref);
      if (done !== undefined) {
        images[service] = done;
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
      const r = await podman(d, app, [...args, ref], 15 * 60_000);
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
    }
  } finally {
    await rm(authFile, { force: true });
  }
  return { images };
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
