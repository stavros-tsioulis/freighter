import { SECRET_STORAGE_ATTRS, findReferences, isEnvAttr, substituteReferences, type AppFacts, type Reference, type StorageFacts } from "@freighter/manifest";

export type { AppFacts, Connections, StorageFacts } from "@freighter/manifest";

/** Thrown for a connection that can't be resolved; the message says which one and why. */
export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceError";
  }
}

/** A resolved value, and whether it carries a credential (then it belongs in a root-only file, not in a unit). */
interface Resolved {
  text: string;
  secret: boolean;
}
export type EnvResult = { value: string; secret: boolean } | { error: string };

/**
 * Resolve the references in `self`'s environment, one result per entry so a broken reference doesn't hide the rest. `peers`
 * are the other apps a reference may name (the caller decides which: the control plane passes the apps of the same project)
 * and `storages` the S3 storages (`@storage:name.url`). A reference to an environment value is resolved in the context of
 * the app that owns it, and a chain that loops back on itself is an error. A value that uses a storage's key pair, directly
 * or through another value, is marked `secret`.
 */
export function resolveEnvironmentEach(self: AppFacts, peers: Record<string, AppFacts> = {}, storages: Record<string, StorageFacts> = {}): Record<string, EnvResult> {
  const apps: Record<string, AppFacts> = { ...peers, [self.name]: self };
  const done = new Map<string, Resolved>();
  const stack: string[] = [];

  const lookupStorage = (from: AppFacts, ref: Extract<Reference, { storage: string }>): Resolved => {
    const st = storages[ref.storage];
    if (!st) throw new ReferenceError(`${ref.text}: there is no storage "${ref.storage}"`);
    const plain = (text: string): Resolved => ({ text, secret: false });
    switch (ref.attr) {
      case "domain":
        if (!st.hostname) throw new ReferenceError(`${ref.text}: storage "${st.name}" has no domain yet`);
        return plain(st.hostname);
      case "url":
        if (st.hostname) return plain(`${st.tls === "auto" ? "https" : "http"}://${st.hostname}`);
        if (st.port === undefined) throw new ReferenceError(`${ref.text}: storage "${st.name}" has no domain or port yet`);
        if (st.server !== undefined && from.server !== undefined && st.server !== from.server) {
          throw new ReferenceError(`${ref.text}: storage "${st.name}" has no domain and runs on server "${st.server}", not "${from.server}"; give it a domain`);
        }
        return plain(`http://127.0.0.1:${st.port}`);
      case "internal":
        if (st.port === undefined) throw new ReferenceError(`${ref.text}: storage "${st.name}" has no port yet`);
        if (st.server !== undefined && from.server !== undefined && st.server !== from.server) {
          throw new ReferenceError(`${ref.text}: storage "${st.name}" runs on server "${st.server}", not "${from.server}", so it has no internal address here; use .url instead`);
        }
        return plain(`http://127.0.0.1:${st.port}`);
      case "region":
        return plain("us-east-1");
      case "accessKey":
      case "secretKey":
        return { text: ref.attr === "accessKey" ? st.accessKey : st.secretKey, secret: SECRET_STORAGE_ATTRS.includes(ref.attr) };
    }
  };

  const lookup = (from: AppFacts, ref: Reference): Resolved => {
    if (ref.storage !== undefined) return lookupStorage(from, ref);
    const owner = ref.app === undefined ? from : apps[ref.app];
    if (!owner) throw new ReferenceError(`${ref.text}: there is no app "${ref.app}" to connect to (apps can only connect to others in the same project)`);
    if (!owner.services.includes(ref.service)) throw new ReferenceError(`${ref.text}: app "${owner.name}" has no service "${ref.service}"`);
    const where = owner === from ? "" : ` (app ${owner.name})`;
    const plain = (text: string): Resolved => ({ text, secret: false });
    switch (ref.attr) {
      case "domain":
      case "url": {
        const dom = owner.domains.find((x) => x.service === ref.service);
        if (!dom) throw new ReferenceError(`${ref.text}: service "${ref.service}"${where} has no domain yet`);
        return plain(ref.attr === "domain" ? dom.hostname : `${dom.tls === "auto" ? "https" : "http"}://${dom.hostname}`);
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
          return plain(`http://127.0.0.1:${port}`);
        }
        return plain(String(port));
      }
      default: {
        if (!isEnvAttr(ref.attr)) throw new ReferenceError(`${ref.text}: unknown attribute`);
        if (!(ref.attr in owner.environment)) throw new ReferenceError(`${ref.text}: ${ref.attr} is not set in the environment of app "${owner.name}" (secrets can't be referenced)`);
        return value(owner, ref.attr);
      }
    }
  };

  const value = (app: AppFacts, key: string): Resolved => {
    const id = `${app.name}/${key}`;
    const cached = done.get(id);
    if (cached !== undefined) return cached;
    if (stack.includes(id)) throw new ReferenceError(`environment values refer to each other in a loop: ${[...stack, id].join(" -> ")}`);
    stack.push(id);
    try {
      let secret = false;
      const text = substituteReferences(app.environment[key]!, (ref) => {
        const r = lookup(app, ref);
        secret ||= r.secret;
        return r.text;
      });
      const out = { text, secret };
      done.set(id, out);
      return out;
    } finally {
      stack.pop();
    }
  };

  return Object.fromEntries(
    Object.keys(self.environment).map((k): [string, EnvResult] => {
      try {
        const r = value(self, k);
        return [k, { value: r.text, secret: r.secret }];
      } catch (e) {
        if (!(e instanceof ReferenceError)) throw e;
        return [k, { error: e.message.startsWith("environment values") ? e.message : `${k}: ${e.message}` }];
      }
    }),
  );
}

/** Resolve the references in `self`'s environment (see `resolveEnvironmentEach`), split into plain values and secrets; the first one that can't be resolved throws. */
export function resolveEnvironmentSplit(self: AppFacts, peers: Record<string, AppFacts> = {}, storages: Record<string, StorageFacts> = {}): { plain: Record<string, string>; secret: Record<string, string> } {
  const out = { plain: {} as Record<string, string>, secret: {} as Record<string, string> };
  for (const [k, r] of Object.entries(resolveEnvironmentEach(self, peers, storages))) {
    if ("error" in r) throw new ReferenceError(r.error);
    (r.secret ? out.secret : out.plain)[k] = r.value;
  }
  return out;
}

/** Like `resolveEnvironmentSplit`, with everything in one map. */
export function resolveEnvironment(self: AppFacts, peers: Record<string, AppFacts> = {}, storages: Record<string, StorageFacts> = {}): Record<string, string> {
  const { plain, secret } = resolveEnvironmentSplit(self, peers, storages);
  return { ...plain, ...secret };
}

/** The apps a manifest's environment names with `@app/service...`, other than itself. */
export function referencedApps(self: string, environment: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(environment)) for (const r of findReferences(v)) if (r.storage === undefined && r.app !== undefined && r.app !== self) out.add(r.app);
  return [...out].sort();
}
