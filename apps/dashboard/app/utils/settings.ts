import type { AppSettings, RemoteVolume } from "~/types";

/** Editable shape of the app.yaml options: arrays of rows and text boxes, converted to/from the API's settings. */
export interface ServiceForm {
  name: string;
  /** What runs: a command on the host, or a container image pulled from a registry. */
  kind: "command" | "image";
  command: string;
  /** Image services: reference such as ghcr.io/acme/shop:1.4. */
  image: string;
  /** Image services: the port the image listens on inside the container. */
  containerPort: number | null;
  /** Image services: persistent directories (name -> path in the container). */
  volumes: { name: string; path: string }[];
  port: number | null;
  replicas: number;
  memory: string;
  cpu: number | null;
  healthPath: string;
  healthTimeout: string;
  restart: "always" | "on-failure" | "no";
  env: { key: string; value: string }[];
  /** One name per line (or comma separated). */
  secrets: string;
}
/** A remote folder as the form edits it: every field of both kinds, only the ones of the chosen type are sent. */
export interface RemoteVolumeForm {
  name: string;
  type: "smb" | "nfs";
  host: string;
  share: string;
  path: string;
  user: string;
  domain: string;
  port: number | null;
  export: string;
  version: string;
}
export const newRemoteVolume = (): RemoteVolumeForm => ({ name: "", type: "smb", host: "", share: "", path: "", user: "", domain: "", port: null, export: "", version: "4" });

export interface SettingsForm {
  services: ServiceForm[];
  remoteVolumes: RemoteVolumeForm[];
  /** Values for every service at run time (a service's own wins). */
  env: { key: string; value: string }[];
  /** One command per line. */
  buildCommands: string;
  /** Values the build commands see. */
  buildEnv: { key: string; value: string }[];
  buildTimeout: string;
  buildMemory: string;
  buildCpu: number | null;
  keep: number;
}

export const newService = (name = "web", kind: ServiceForm["kind"] = "command"): ServiceForm => ({ name, kind, command: "", image: "", containerPort: null, volumes: [], port: null, replicas: 1, memory: "", cpu: null, healthPath: "", healthTimeout: "", restart: "on-failure", env: [], secrets: "" });

export const emptyForm = (): SettingsForm => ({
  services: [newService()],
  remoteVolumes: [],
  env: [],
  buildCommands: "",
  buildEnv: [],
  buildTimeout: "",
  buildMemory: "",
  buildCpu: null,
  keep: 5,
});

const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/** Drop empty fields so the generated app.yaml only says what was actually chosen. */
export function toSettings(f: SettingsForm): AppSettings {
  const services: AppSettings["services"] = {};
  for (const s of f.services) {
    if (!s.name.trim()) continue;
    const volumes = s.volumes.filter((v) => v.name.trim() && v.path.trim());
    const env = s.env.filter((e) => e.key.trim());
    const secrets = lines(s.secrets);
    services[s.name.trim()] = {
      ...(s.kind === "image"
        ? {
            image: normalizeImage(s.image),
            ...(s.containerPort ? { containerPort: s.containerPort } : {}),
          }
        : { command: s.command.trim() }),
      ...(volumes.length ? { volumes: Object.fromEntries(volumes.map((v) => [v.name.trim(), v.path.trim()])) } : {}),
      ...(s.port ? { port: s.port } : {}),
      replicas: s.replicas || 1,
      ...(s.memory.trim() || s.cpu ? { resources: { ...(s.memory.trim() ? { memory: s.memory.trim() } : {}), ...(s.cpu ? { cpu: s.cpu } : {}) } } : {}),
      ...(s.healthPath.trim() ? { healthcheck: { path: s.healthPath.trim(), ...(s.healthTimeout.trim() ? { timeout: s.healthTimeout.trim() } : {}) } } : {}),
      restart: s.restart,
      ...(env.length ? { environment: Object.fromEntries(env.map((e) => [e.key.trim(), e.value])) } : {}),
      ...(secrets.length ? { secrets } : {}),
    };
  }
  const remote = f.remoteVolumes
    .filter((v) => v.name.trim() && v.host.trim())
    .map((v): [string, RemoteVolume] => [
      v.name.trim(),
      v.type === "smb"
        ? { type: "smb", host: v.host.trim(), share: v.share.trim(), user: v.user.trim(), ...(v.path.trim() ? { path: v.path.trim() } : {}), ...(v.domain.trim() ? { domain: v.domain.trim() } : {}), ...(v.port ? { port: v.port } : {}) }
        : { type: "nfs", host: v.host.trim(), export: v.export.trim(), ...(v.version ? { version: v.version } : {}) },
    ]);
  const commands = f.buildCommands.split("\n").map((c) => c.trim()).filter(Boolean);
  const pairs = (rows: { key: string; value: string }[]) => Object.fromEntries(rows.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]));
  const buildEnv = pairs(f.buildEnv);
  const env = pairs(f.env);
  return {
    ...(commands.length
      ? { build: { commands, ...(f.buildTimeout.trim() ? { timeout: f.buildTimeout.trim() } : {}), ...(f.buildMemory.trim() ? { memory: f.buildMemory.trim() } : {}), ...(f.buildCpu ? { cpu: f.buildCpu } : {}), ...(Object.keys(buildEnv).length ? { environment: buildEnv } : {}) } }
      : {}),
    ...(Object.keys(env).length ? { environment: env } : {}),
    services,
    ...(remote.length ? { volumes: Object.fromEntries(remote) } : {}),
    releases: { keep: f.keep || 5 },
  };
}

export function fromSettings(s: AppSettings | null | undefined): SettingsForm {
  if (!s) return emptyForm();
  const services = Object.entries(s.services ?? {}).map(([name, v]) => ({
    name,
    kind: v.image !== undefined ? ("image" as const) : ("command" as const),
    command: v.command ?? "",
    image: v.image ?? "",
    containerPort: v.containerPort ?? null,
    volumes: Object.entries(v.volumes ?? {}).map(([name, path]) => ({ name, path })),
    port: v.port ?? null,
    replicas: v.replicas ?? 1,
    memory: v.resources?.memory ?? "",
    cpu: v.resources?.cpu ?? null,
    healthPath: v.healthcheck?.path ?? "",
    healthTimeout: v.healthcheck?.timeout ?? "",
    restart: v.restart ?? "on-failure",
    env: Object.entries(v.environment ?? {}).map(([key, value]) => ({ key, value })),
    secrets: (v.secrets ?? []).join("\n"),
  }));
  return {
    services: services.length ? services : [newService()],
    remoteVolumes: Object.entries(s.volumes ?? {}).map(([name, v]) => ({
      ...newRemoteVolume(),
      name,
      type: v.type,
      host: v.host,
      ...(v.type === "smb" ? { share: v.share, path: v.path ?? "", user: v.user, domain: v.domain ?? "", port: v.port ?? null } : { export: v.export, version: v.version ?? "4" }),
    })),
    env: Object.entries(s.environment ?? {}).map(([key, value]) => ({ key, value })),
    buildCommands: (s.build?.commands ?? []).join("\n"),
    buildEnv: Object.entries(s.build?.environment ?? {}).map(([key, value]) => ({ key, value })),
    buildTimeout: s.build?.timeout ?? "",
    buildMemory: s.build?.memory ?? "",
    buildCpu: s.build?.cpu ?? null,
    keep: s.releases?.keep ?? 5,
  };
}

/** True once there is something deployable (a service with a command, or with an image). */
export const hasService = (f: SettingsForm) => f.services.some((s) => s.name.trim() && (s.kind === "image" ? s.image.trim() : s.command.trim()));

/** Whether every service with a name runs an image, so the app needs no upload (the server pulls it). */
export const imagesOnly = (f: SettingsForm) => f.services.filter((s) => s.name.trim()).every((s) => s.kind === "image");

/** A pragmatic client-side check of an image reference; the API applies the real rules. */
export const IMAGE_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

/** `docker://ghcr.io/org/app:1.2`, as pasted from skopeo or podman, is the image `ghcr.io/org/app:1.2`. */
export const normalizeImage = (ref: string) => ref.trim().replace(/^docker:\/\//i, "");
export const isImage = (ref: string) => IMAGE_RE.test(normalizeImage(ref));

/** The registry host an image comes from (Docker Hub when the reference names none). */
export function imageHost(raw: string): string {
  const ref = normalizeImage(raw);
  const first = ref.split("/")[0]!;
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}
