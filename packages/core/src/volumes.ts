import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { type Manifest, type Volume } from "@freighter/manifest";
import { mountUnitName, renderMountUnit, volumeCredentialsFile, volumeDir } from "@freighter/systemd";
import type { Deps } from "./deps.ts";

/**
 * Volumes are folders of an app: `/srv/apps/<app>/shared/volumes/<name>`. A service attaches one under `volumes:` and
 * sees it at the path it asks for. Without more they are plain folders. A volume declared under the app's `volumes:`
 * is a remote folder (SMB, NFS) mounted onto that same place by a systemd mount unit, owned by the app's user.
 */
const passwordFile = (d: Deps, app: string, name: string) => `${d.layout.envDir}/${app}/volumes/${name}.password`;

export const volumeMountUnit = (d: Deps, app: string, name: string) => mountUnitName(volumeDir(d.layout, app, name));

/** Every volume name the app uses: declared ones, and the ones services attach. */
export const volumeNames = (m: Pick<Manifest, "services" | "volumes">): string[] => [...new Set([...Object.keys(m.volumes), ...Object.values(m.services).flatMap((s) => Object.keys(s.volumes ?? {}))])].sort();

/** The password of an SMB volume. It is written to a root-only file and never read back. */
export async function setVolumePassword(d: Deps, app: string, name: string, password: string): Promise<void> {
  if (!password || /[\r\n\0]/.test(password)) throw new Error("a password can't be empty or contain newlines");
  await mkdir(`${d.layout.envDir}/${app}/volumes`, { recursive: true, mode: 0o700 });
  const path = passwordFile(d, app, name);
  await writeFile(`${path}.tmp`, password, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function hasVolumePassword(d: Deps, app: string, name: string): Promise<boolean> {
  return readFile(passwordFile(d, app, name)).then(() => true, () => false);
}

/** Remote volumes of a manifest that can't be mounted yet because their password isn't set, as `volume NAME`. */
export async function missingVolumePasswords(d: Deps, manifest: Pick<Manifest, "name" | "volumes">): Promise<string[]> {
  const out: string[] = [];
  for (const [name, v] of Object.entries(manifest.volumes)) if (v.type === "smb" && !(await hasVolumePassword(d, manifest.name, name))) out.push(name);
  return out;
}

/** Whether this server has the tools to mount each kind. */
export async function mountSupport(d: Deps): Promise<{ smb: boolean; nfs: boolean }> {
  const has = async (tool: string) => (await d.run("sh", ["-c", `command -v ${tool}`]).catch(() => ({ code: 1 }))).code === 0;
  return { smb: await has("mount.cifs"), nfs: await has("mount.nfs") };
}
export const NO_MOUNTS_MESSAGE = "this server can't mount remote volumes yet: add mount support from the Servers page (or install cifs-utils / nfs-common)";

async function credentials(d: Deps, app: string, name: string, v: Extract<Volume, { type: "smb" }>): Promise<void> {
  const password = await readFile(passwordFile(d, app, name), "utf8").catch(() => null);
  if (password === null) throw new Error(`volume ${name} has no password yet: set it on the app's Settings tab`);
  const path = volumeCredentialsFile(d.layout, app, name);
  await mkdir(`${d.layout.envDir}/${app}/volumes`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, [`username=${v.user}`, `password=${password}`, ...(v.domain ? [`domain=${v.domain}`] : [])].join("\n") + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/**
 * Make the app's volumes exist before its services start: the folders, owned by the app's user, and the mounts of the
 * remote ones (a mount that doesn't come up fails the deploy). Mount units of volumes the app no longer declares are
 * removed by `retireMounts` once the new release is live.
 */
export async function syncVolumes(d: Deps, app: string, manifest: Pick<Manifest, "services" | "volumes">): Promise<void> {
  const remote = Object.entries(manifest.volumes);
  if (remote.length > 0 && !d.dev) {
    const support = await mountSupport(d);
    for (const [, v] of remote) if (!support[v.type]) throw new Error(`${NO_MOUNTS_MESSAGE} (${v.type === "smb" ? "SMB" : "NFS"})`);
  }
  for (const name of volumeNames(manifest)) {
    const dir = volumeDir(d.layout, app, name);
    await mkdir(dir, { recursive: true });
    if (!(name in manifest.volumes) && !d.dev) await d.run("chown", [`${app}:${app}`, dir]);
  }
  for (const [name, v] of remote) {
    if (v.type === "smb") await credentials(d, app, name, v);
    const unit = volumeMountUnit(d, app, name);
    const text = renderMountUnit({ app, name, volume: v, layout: d.layout });
    const before = await readFile(`${d.layout.unitDir}/${unit}`, "utf8").catch(() => null);
    await d.systemd.installUnit(unit, text);
    await d.systemd.enable(unit);
    const active = (await d.systemd.status(unit)).activeState === "active";
    if (!active) await d.systemd.start(unit);
    else if (before !== null && before !== text) await d.systemd.restart(unit);
    const status = await d.systemd.status(unit);
    if (status.activeState !== "active") {
      const log = (await d.run("journalctl", d.systemd.logsArgs(unit, { lines: 8 })).catch(() => ({ stdout: "" }))).stdout.trim();
      throw new Error(`volume ${name} could not be mounted (${status.activeState}/${status.subState})${log ? `:\n${log}` : ""}`);
    }
  }
}

/** The mount units this app has on disk. */
async function ownedMounts(d: Deps, app: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(d.layout.unitDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of files.filter((f) => f.endsWith(".mount"))) {
    if ((await readFile(`${d.layout.unitDir}/${f}`, "utf8").catch(() => "")).includes(`\nX-Freighter-App=${app}\n`)) out.push(f);
  }
  return out;
}

/** Unmount and remove the app's mount units that aren't in `keep` (volume names). Returns the units removed. */
export async function retireMounts(d: Deps, app: string, keep: Iterable<string>): Promise<string[]> {
  const names = new Set(keep);
  const wanted = new Set([...names].map((n) => volumeMountUnit(d, app, n)));
  const removed: string[] = [];
  for (const unit of await ownedMounts(d, app)) {
    if (wanted.has(unit)) continue;
    await d.systemd.stop(unit);
    await d.systemd.disable(unit);
    await d.systemd.removeUnit(unit);
    removed.push(unit);
  }
  // credentials of volumes that are gone
  for (const name of await readdir(`${d.layout.envDir}/${app}/volumes`).catch(() => [] as string[])) {
    const volume = name.replace(/\.(cred|password)$/, "");
    if (!names.has(volume)) await rm(`${d.layout.envDir}/${app}/volumes/${name}`, { force: true });
  }
  return removed;
}

/** What is mounted for each remote volume right now. */
export async function volumeStatus(d: Deps, app: string, manifest: Pick<Manifest, "volumes">): Promise<Record<string, { type: string; state: string; password: boolean | null }>> {
  const out: Record<string, { type: string; state: string; password: boolean | null }> = {};
  for (const [name, v] of Object.entries(manifest.volumes)) {
    const s = await d.systemd.status(volumeMountUnit(d, app, name)).catch(() => null);
    out[name] = { type: v.type, state: s ? (s.activeState === "active" ? "mounted" : s.activeState) : "unknown", password: v.type === "smb" ? await hasVolumePassword(d, app, name) : null };
  }
  return out;
}

/** Refuse to delete a directory while something is still mounted inside it: removing it would reach into the remote share. */
export async function assertNoMounts(dir: string): Promise<void> {
  const info = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  for (const line of info.split("\n")) {
    const point = line.split(" ")[4];
    if (point && (point === dir || point.startsWith(`${dir}/`))) throw new Error(`${point} is still mounted; refusing to delete ${dir} (it would reach into the remote share)`);
  }
}
