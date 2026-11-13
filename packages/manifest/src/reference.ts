/**
 * Connections: an environment value may point at another service, such as `API_URL: "@api.url"`.
 *
 * Syntax: `@[app/]service.attr`, anywhere in a value. `attr` is `domain`, `url`, `internal`, `port`, `host`, or the name of an
 * `environment:` entry of that service (`UPPER_SNAKE_CASE`; `PORT` is the same as `port`). `@@` is a literal `@`.
 * An `@` right after a word character (an email address, say) is never a reference. The braced form `${[app/]service.attr}`
 * is a reference wherever it stands, so it can sit against other text: `redis://${self.USER}:${self.PASS}@${self.HOST}`.
 * Braces that hold anything else (`${HOME}`) are left alone, and `$${` is a literal `${`.
 */
export const REFERENCE_ATTRS = ["domain", "url", "internal", "port", "host"] as const;
export type ReferenceAttr = (typeof REFERENCE_ATTRS)[number];

export const STORAGE_ATTRS = ["url", "domain", "internal", "publicUrl", "region", "accessKey", "secretKey"] as const;
export type StorageAttr = (typeof STORAGE_ATTRS)[number];
/** Storage attributes whose values are credentials: they never go into a (world-readable) unit file. */
export const SECRET_STORAGE_ATTRS: readonly string[] = ["accessKey", "secretKey"];

/** Volume attributes: where it is, as the service that asks sees it. */
export const VOLUME_ATTRS = ["path"] as const;
export type VolumeAttr = (typeof VOLUME_ATTRS)[number];
/** The volume that is the app's whole shared directory. */
export const SHARED_VOLUME = "shared";

/** `@[app/]service.attr`: a service of this app or of another one. */
export interface ServiceReference {
  storage?: undefined;
  volume?: undefined;
  /** The app that owns the service; absent for a service of the same app. */
  app?: string;
  service: string;
  /** One of REFERENCE_ATTRS, or an environment key. */
  attr: string;
  /** The text as written, for messages. */
  text: string;
}
/** `@storage:name.attr`: an S3 storage. Storages are global, so there is no app. */
export interface StorageReference {
  storage: string;
  volume?: undefined;
  app?: undefined;
  service?: undefined;
  attr: StorageAttr;
  text: string;
}
/** `@volume:name.path`: a volume of this app (or `shared`, its shared directory). Volumes belong to one app, so there is no app part. */
export interface VolumeReference {
  volume: string;
  storage?: undefined;
  app?: undefined;
  service?: undefined;
  attr: VolumeAttr;
  text: string;
}
export type Reference = ServiceReference | StorageReference | VolumeReference;

const IDENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
// `storage:` name `.` attr | `volume:` name `.` attr | [app `/`] service `.` attr. The attr must end the identifier, so `api.url_x` is not `api.url`.
const INNER =
  `(?:storage:(?<st>${IDENT})\\.(?<sattr>${STORAGE_ATTRS.join("|")})` +
  `|volume:(?<vol>${IDENT})\\.(?<vattr>${VOLUME_ATTRS.join("|")})` +
  `|(?:(?<app>${IDENT})/)?(?<svc>${IDENT})\\.(?<attr>domain|url|internal|port|host|[A-Z_][A-Z0-9_]*))(?![A-Za-z0-9_])`;
// `@@` | `$${` | `${` anything `}` | `@` reference
const PATTERN = `@@|\\$\\$\\{|\\$\\{(?<br>[^{}]*)\\}|@${INNER}`;
const BRACED = new RegExp(`^${INNER}$`);

export const isEnvAttr = (attr: string): boolean => !(REFERENCE_ATTRS as readonly string[]).includes(attr) && attr !== "PORT";

function toReference(m: { 0: string; groups?: Record<string, string | undefined> }): Reference {
  const g = m.groups!;
  if (g.st !== undefined) return { storage: g.st, attr: g.sattr as StorageAttr, text: m[0] };
  if (g.vol !== undefined) return { volume: g.vol, attr: g.vattr as VolumeAttr, text: m[0] };
  return { app: g.app, service: g.svc!, attr: g.attr!, text: m[0] };
}

const WORD_BEFORE = /[A-Za-z0-9_.+-]/;

/**
 * Walk a value: its escapes (`@@`, `$${`) and references, with where each is. An `@` that follows a word character is
 * text (an email address); a braced reference is one anywhere.
 */
function* scan(value: string): Generator<{ index: number; text: string; ref: Reference | null; literal?: string }> {
  for (const m of value.matchAll(new RegExp(PATTERN, "g"))) {
    const index = m.index!;
    if (m[0] === "@@") yield { index, text: m[0], ref: null, literal: "@" };
    else if (m[0] === "$${") yield { index, text: m[0], ref: null, literal: "${" };
    else if (m.groups!.br !== undefined) {
      const inner = BRACED.exec(m.groups!.br);
      if (inner) yield { index, text: m[0], ref: toReference({ 0: m[0], groups: inner.groups }) };
    } else {
      if (index > 0 && WORD_BEFORE.test(value[index - 1]!)) continue;
      yield { index, text: m[0], ref: toReference(m) };
    }
  }
}

/** The references in a value, in order. */
export function findReferences(value: string): Reference[] {
  const out: Reference[] = [];
  for (const s of scan(value)) if (s.ref) out.push(s.ref);
  return out;
}

/** Replace the references with `change(ref)` (kept as written when it returns null); escapes stay as they are. */
export function rewriteReferences(value: string, change: (ref: Reference) => string | null): string {
  let out = "";
  let at = 0;
  for (const s of scan(value)) {
    if (!s.ref) continue;
    const to = change(s.ref);
    if (to === null) continue;
    out += value.slice(at, s.index) + to;
    at = s.index + s.text.length;
  }
  return out + value.slice(at);
}

/** Replace every reference with `resolve(ref)`, `@@` with `@` and `$${` with `${`. */
export function substituteReferences(value: string, resolve: (ref: Reference) => string): string {
  let out = "";
  let at = 0;
  for (const s of scan(value)) {
    out += value.slice(at, s.index) + (s.ref ? resolve(s.ref) : s.literal!);
    at = s.index + s.text.length;
  }
  return out + value.slice(at);
}

/** One service connecting to another, as the environment of its app says. */
export interface ConnectionEdge {
  from: { app: string; service: string };
  to: { app: string; service: string };
  /** `url`, `internal`, ... or the environment key read from the target. */
  attr: string;
  /** The environment entry of the referencing app that holds the reference. */
  key: string;
}

type EnvOwners = { name: string; services: Record<string, { environment: Record<string, string> }> };

/** The connections a service's environment declares, per service: the one that holds the reference is the consumer. */
export function connectionEdges(m: EnvOwners): ConnectionEdge[] {
  const out = new Map<string, ConnectionEdge>();
  for (const [service, def] of Object.entries(m.services)) {
    for (const [key, value] of Object.entries(def.environment)) {
      for (const ref of findReferences(value)) {
        if (ref.storage !== undefined || ref.volume !== undefined) continue;
        const to = { app: ref.app ?? m.name, service: ref.service };
        if (to.app === m.name && to.service === service) continue;
        out.set(`${service}>${to.app}/${to.service}.${ref.attr}:${key}`, { from: { app: m.name, service }, to, attr: ref.attr, key });
      }
    }
  }
  return [...out.values()];
}

/** One service using a storage (`@storage:name.attr`). */
export interface StorageEdge {
  from: { app: string; service: string };
  storage: string;
  attr: StorageAttr;
  key: string;
}

/** The storages the services' environments use. */
export function storageEdges(m: EnvOwners): StorageEdge[] {
  const out = new Map<string, StorageEdge>();
  for (const [service, def] of Object.entries(m.services)) {
    for (const [key, value] of Object.entries(def.environment)) {
      for (const ref of findReferences(value)) {
        if (ref.storage === undefined) continue;
        out.set(`${service}>${ref.storage}.${ref.attr}:${key}`, { from: { app: m.name, service }, storage: ref.storage, attr: ref.attr, key });
      }
    }
  }
  return [...out.values()];
}

/** Names of the storages a set of environment values uses. */
export function referencedStorages(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) for (const r of findReferences(v)) if (r.storage !== undefined) out.add(r.storage);
  return [...out].sort();
}

/**
 * Where each service sees each volume: a command service sees `shared`, the app's folders (at the host path unless it
 * binds them elsewhere) and, at the path it asked for, the ones it attaches; an image sees only what it attaches (at the
 * path inside its container). `shared` is the app's shared directory on the host.
 */
export function volumePaths(
  m: { services: Record<string, { image?: string; volumes?: Record<string, string> }>; volumes?: Record<string, unknown> },
  shared: string,
): Record<string, Record<string, string>> {
  const names = new Set([...Object.keys(m.volumes ?? {}), ...Object.values(m.services).flatMap((s) => Object.keys(s.volumes ?? {}))]);
  return Object.fromEntries(
    Object.entries(m.services).map(([service, def]) => {
      const own: Record<string, string> = def.image === undefined ? { [SHARED_VOLUME]: shared, ...Object.fromEntries([...names].map((n) => [n, `${shared}/volumes/${n}`])) } : {};
      return [service, { ...own, ...def.volumes }];
    }),
  );
}

/** Every environment value of every service of an app. */
export function environmentValues(m: { services: Record<string, { environment: Record<string, string> }> }): string[] {
  return Object.values(m.services).flatMap((s) => Object.values(s.environment));
}
