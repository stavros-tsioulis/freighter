import { findReferences, isEnvAttr, substituteReferences, type AppFacts, type Reference } from "@freighter/manifest";

export type { AppFacts, Connections } from "@freighter/manifest";

/** Thrown for a connection that can't be resolved; the message says which one and why. */
export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceError";
  }
}

/**
 * Resolve the references in `self`'s environment. `peers` are the other apps a reference may name (the caller decides
 * which: the control plane passes the apps of the same project). A reference to an environment value is resolved in
 * the context of the app that owns it, and a chain that loops back on itself is an error.
 */
export function resolveEnvironment(self: AppFacts, peers: Record<string, AppFacts> = {}): Record<string, string> {
  const apps: Record<string, AppFacts> = { ...peers, [self.name]: self };
  const done = new Map<string, string>();
  const stack: string[] = [];

  const lookup = (from: AppFacts, ref: Reference): string => {
    const owner = ref.app === undefined ? from : apps[ref.app];
    if (!owner) throw new ReferenceError(`${ref.text}: there is no app "${ref.app}" to connect to (apps can only connect to others in the same project)`);
    if (!owner.services.includes(ref.service)) throw new ReferenceError(`${ref.text}: app "${owner.name}" has no service "${ref.service}"`);
    const where = owner === from ? "" : ` (app ${owner.name})`;
    switch (ref.attr) {
      case "domain":
      case "url": {
        const dom = owner.domains.find((x) => x.service === ref.service);
        if (!dom) throw new ReferenceError(`${ref.text}: service "${ref.service}"${where} has no domain yet`);
        return ref.attr === "domain" ? dom.hostname : `${dom.tls === "auto" ? "https" : "http"}://${dom.hostname}`;
      }
      case "internal":
      case "port":
      case "PORT": {
        const port = owner.ports[ref.service];
        if (port === undefined) throw new ReferenceError(`${ref.text}: service "${ref.service}"${where} has no port (give it a domain or a port)`);
        if (ref.attr === "internal") {
          if (owner.server !== undefined && from.server !== undefined && owner.server !== from.server) {
            throw new ReferenceError(`${ref.text}: ${owner.name} runs on server "${owner.server}", not "${from.server}", so it has no internal address here; use .url instead`);
          }
          return `http://127.0.0.1:${port}`;
        }
        return String(port);
      }
      default: {
        if (!isEnvAttr(ref.attr)) throw new ReferenceError(`${ref.text}: unknown attribute`);
        if (!(ref.attr in owner.environment)) throw new ReferenceError(`${ref.text}: ${ref.attr} is not set in the environment of app "${owner.name}" (secrets can't be referenced)`);
        return value(owner, ref.attr);
      }
    }
  };

  const value = (app: AppFacts, key: string): string => {
    const id = `${app.name}/${key}`;
    const cached = done.get(id);
    if (cached !== undefined) return cached;
    if (stack.includes(id)) throw new ReferenceError(`environment values refer to each other in a loop: ${[...stack, id].join(" -> ")}`);
    stack.push(id);
    try {
      const out = substituteReferences(app.environment[key]!, (ref) => lookup(app, ref));
      done.set(id, out);
      return out;
    } finally {
      stack.pop();
    }
  };

  return Object.fromEntries(
    Object.keys(self.environment).map((k) => {
      try {
        return [k, value(self, k)];
      } catch (e) {
        if (e instanceof ReferenceError && !e.message.startsWith("environment values")) throw new ReferenceError(`${k}: ${e.message}`);
        throw e;
      }
    }),
  );
}

/** The apps a manifest's environment names with `@app/service...`, other than itself. */
export function referencedApps(self: string, environment: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(environment)) for (const r of findReferences(v)) if (r.app !== undefined && r.app !== self) out.add(r.app);
  return [...out].sort();
}
