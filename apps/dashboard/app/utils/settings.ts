import type { AppSettings } from "~/types";

/** Editable shape of the app.yaml options: arrays of rows and text boxes, converted to/from the API's settings. */
export interface ServiceForm {
  name: string;
  command: string;
  port: number | null;
  replicas: number;
  memory: string;
  cpu: number | null;
  healthPath: string;
  healthTimeout: string;
  restart: "always" | "on-failure" | "no";
}
export interface SettingsForm {
  services: ServiceForm[];
  env: { key: string; value: string }[];
  /** One name per line (or comma separated). */
  secrets: string;
  /** One command per line. */
  buildCommands: string;
  buildTimeout: string;
  buildMemory: string;
  buildCpu: number | null;
  keep: number;
}

export const newService = (name = "web"): ServiceForm => ({ name, command: "", port: null, replicas: 1, memory: "", cpu: null, healthPath: "", healthTimeout: "", restart: "on-failure" });

export const emptyForm = (): SettingsForm => ({
  services: [newService()],
  env: [],
  secrets: "",
  buildCommands: "",
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
    services[s.name.trim()] = {
      command: s.command.trim(),
      ...(s.port ? { port: s.port } : {}),
      replicas: s.replicas || 1,
      ...(s.memory.trim() || s.cpu ? { resources: { ...(s.memory.trim() ? { memory: s.memory.trim() } : {}), ...(s.cpu ? { cpu: s.cpu } : {}) } } : {}),
      ...(s.healthPath.trim() ? { healthcheck: { path: s.healthPath.trim(), ...(s.healthTimeout.trim() ? { timeout: s.healthTimeout.trim() } : {}) } } : {}),
      restart: s.restart,
    };
  }
  const commands = f.buildCommands.split("\n").map((c) => c.trim()).filter(Boolean);
  return {
    ...(commands.length
      ? { build: { commands, ...(f.buildTimeout.trim() ? { timeout: f.buildTimeout.trim() } : {}), ...(f.buildMemory.trim() ? { memory: f.buildMemory.trim() } : {}), ...(f.buildCpu ? { cpu: f.buildCpu } : {}) } }
      : {}),
    services,
    environment: Object.fromEntries(f.env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value])),
    secrets: lines(f.secrets),
    releases: { keep: f.keep || 5 },
  };
}

export function fromSettings(s: AppSettings | null | undefined): SettingsForm {
  if (!s) return emptyForm();
  const services = Object.entries(s.services ?? {}).map(([name, v]) => ({
    name,
    command: v.command,
    port: v.port ?? null,
    replicas: v.replicas ?? 1,
    memory: v.resources?.memory ?? "",
    cpu: v.resources?.cpu ?? null,
    healthPath: v.healthcheck?.path ?? "",
    healthTimeout: v.healthcheck?.timeout ?? "",
    restart: v.restart ?? "on-failure",
  }));
  return {
    services: services.length ? services : [newService()],
    env: Object.entries(s.environment ?? {}).map(([key, value]) => ({ key, value })),
    secrets: (s.secrets ?? []).join("\n"),
    buildCommands: (s.build?.commands ?? []).join("\n"),
    buildTimeout: s.build?.timeout ?? "",
    buildMemory: s.build?.memory ?? "",
    buildCpu: s.build?.cpu ?? null,
    keep: s.releases?.keep ?? 5,
  };
}

/** True once there is something deployable (a service with a command). */
export const hasService = (f: SettingsForm) => f.services.some((s) => s.name.trim() && s.command.trim());
