/**
 * Connections: an environment value may point at another service, such as `API_URL: "@api.url"`.
 *
 * Syntax: `@[app/]service.attr`, anywhere in a value. `attr` is `domain`, `url`, `internal`, `port`, or the name of an
 * `environment:` entry of the service's app (`UPPER_SNAKE_CASE`; `PORT` is the same as `port`). `@@` is a literal `@`.
 * An `@` right after a word character (an email address, say) is never a reference.
 */
export const REFERENCE_ATTRS = ["domain", "url", "internal", "port"] as const;
export type ReferenceAttr = (typeof REFERENCE_ATTRS)[number];

export interface Reference {
  /** The app that owns the service; absent for a service of the same app. */
  app?: string;
  service: string;
  /** One of REFERENCE_ATTRS, or an environment key. */
  attr: string;
  /** The text as written, for messages. */
  text: string;
}

const IDENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
// `@@` | `@` [app `/`] service `.` attr. The attr must end the identifier, so `@api.url_x` is not `@api.url`.
const PATTERN = `@@|(?<![A-Za-z0-9_.+-])@(?:(${IDENT})/)?(${IDENT})\\.(domain|url|internal|port|[A-Z_][A-Z0-9_]*)(?![A-Za-z0-9_])`;

export const isEnvAttr = (attr: string): boolean => !(REFERENCE_ATTRS as readonly string[]).includes(attr) && attr !== "PORT";

/** The references in a value, in order. */
export function findReferences(value: string): Reference[] {
  const out: Reference[] = [];
  for (const m of value.matchAll(new RegExp(PATTERN, "g"))) {
    if (m[0] === "@@") continue;
    out.push({ app: m[1], service: m[2]!, attr: m[3]!, text: m[0] });
  }
  return out;
}

/** Replace every reference with `resolve(ref)` and `@@` with `@`. */
export function substituteReferences(value: string, resolve: (ref: Reference) => string): string {
  return value.replace(new RegExp(PATTERN, "g"), (text, app: string | undefined, service: string | undefined, attr: string | undefined) =>
    text === "@@" ? "@" : resolve({ app, service: service!, attr: attr!, text }),
  );
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
