/**
 * Connections: an environment value may point at another service, such as `API_URL: "@api.url"`.
 *
 * Syntax: `@[app/]service.attr`, anywhere in a value. `attr` is `domain`, `url`, `internal`, `port`, or the name of an
 * `environment:` entry of the service's app (`UPPER_SNAKE_CASE`; `PORT` is the same as `port`). `@@` is a literal `@`.
 * An `@` right after a word character (an email address, say) is never a reference.
 */
export const REFERENCE_ATTRS = ["domain", "url", "internal", "port"] as const;
export type ReferenceAttr = (typeof REFERENCE_ATTRS)[number];

export const STORAGE_ATTRS = ["url", "domain", "internal", "region", "accessKey", "secretKey"] as const;
export type StorageAttr = (typeof STORAGE_ATTRS)[number];
/** Storage attributes whose values are credentials: they never go into a (world-readable) unit file. */
export const SECRET_STORAGE_ATTRS: readonly string[] = ["accessKey", "secretKey"];

/** `@[app/]service.attr`: a service of this app or of another one. */
export interface ServiceReference {
  storage?: undefined;
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
  app?: undefined;
  service?: undefined;
  attr: StorageAttr;
  text: string;
}
export type Reference = ServiceReference | StorageReference;

const IDENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
// `@@` | `@` (`storage:` name `.` attr | [app `/`] service `.` attr). The attr must end the identifier, so `@api.url_x` is not `@api.url`.
const PATTERN =
  `@@|(?<![A-Za-z0-9_.+-])@(?:storage:(?<st>${IDENT})\\.(?<sattr>${STORAGE_ATTRS.join("|")})` +
  `|(?:(?<app>${IDENT})/)?(?<svc>${IDENT})\\.(?<attr>domain|url|internal|port|[A-Z_][A-Z0-9_]*))(?![A-Za-z0-9_])`;

export const isEnvAttr = (attr: string): boolean => !(REFERENCE_ATTRS as readonly string[]).includes(attr) && attr !== "PORT";

function toReference(m: { 0: string; groups?: Record<string, string | undefined> }): Reference {
  const g = m.groups!;
  if (g.st !== undefined) return { storage: g.st, attr: g.sattr as StorageAttr, text: m[0] };
  return { app: g.app, service: g.svc!, attr: g.attr!, text: m[0] };
}

/** The references in a value, in order. */
export function findReferences(value: string): Reference[] {
  const out: Reference[] = [];
  for (const m of value.matchAll(new RegExp(PATTERN, "g"))) if (m[0] !== "@@") out.push(toReference(m));
  return out;
}

/** Replace every reference with `resolve(ref)` and `@@` with `@`. */
export function substituteReferences(value: string, resolve: (ref: Reference) => string): string {
  return value.replace(new RegExp(PATTERN, "g"), (...args) => {
    const text = args[0] as string;
    if (text === "@@") return "@";
    return resolve(toReference({ 0: text, groups: args.at(-1) as Record<string, string | undefined> }));
  });
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

/**
 * The connections an app's environment declares. Environment is app-wide, so every service of the app (other than the
 * target itself) is a consumer of each reference.
 */
export function connectionEdges(m: { name: string; services: Record<string, unknown>; environment: Record<string, string> }): ConnectionEdge[] {
  const out = new Map<string, ConnectionEdge>();
  for (const [key, value] of Object.entries(m.environment)) {
    for (const ref of findReferences(value)) {
      if (ref.storage !== undefined) continue;
      const to = { app: ref.app ?? m.name, service: ref.service };
      for (const service of Object.keys(m.services)) {
        if (to.app === m.name && to.service === service) continue;
        const from = { app: m.name, service };
        out.set(`${service}>${to.app}/${to.service}.${ref.attr}:${key}`, { from, to, attr: ref.attr, key });
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

/** The storages an app's environment uses; every service of the app is a consumer, as for `connectionEdges`. */
export function storageEdges(m: { name: string; services: Record<string, unknown>; environment: Record<string, string> }): StorageEdge[] {
  const out = new Map<string, StorageEdge>();
  for (const [key, value] of Object.entries(m.environment)) {
    for (const ref of findReferences(value)) {
      if (ref.storage === undefined) continue;
      for (const service of Object.keys(m.services)) out.set(`${service}>${ref.storage}.${ref.attr}:${key}`, { from: { app: m.name, service }, storage: ref.storage, attr: ref.attr, key });
    }
  }
  return [...out.values()];
}

/** Names of the storages an environment uses. */
export function referencedStorages(environment: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(environment)) for (const r of findReferences(v)) if (r.storage !== undefined) out.add(r.storage);
  return [...out].sort();
}
