/** Completing `@...` connections in an environment value (see the grammar in packages/manifest/src/reference.ts). */
export const SERVICE_ATTRS: Record<string, string> = {
  domain: "the service's domain",
  url: "https://domain",
  internal: "http://127.0.0.1:port",
  port: "the service's port",
};
export const STORAGE_ATTRS: Record<string, string> = {
  url: "https://domain, or the local address",
  domain: "the storage's domain",
  internal: "http://127.0.0.1:port",
  region: "us-east-1",
  accessKey: "credential",
  secretKey: "credential",
};

export const VOLUME_ATTRS: Record<string, string> = { path: "where the service sees it" };

/** What a connection in this app's environment can point at. */
export interface ReferenceSources {
  /** The services of the app itself. */
  services: string[];
  /** The environment names of the app's own services, for `@api.NAME`. */
  env: Record<string, string[]>;
  /** The other apps of the project. */
  peers: { app: string; services: string[] }[];
  storages: string[];
  /** The app's volumes (`shared` is always there and is not listed). */
  volumes: string[];
}

export interface Suggestion {
  /** What goes after the `@`, up to the cursor. */
  insert: string;
  label: string;
  detail: string;
  /** More has to be chosen after this one (an attribute follows a service). */
  more: boolean;
}

/** The reference being typed at `caret`: where its text after the `@` starts, and what is typed so far. Null outside one. */
export function referenceAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (!/^[A-Za-z0-9:/._-]*$/.test(query)) return null;
  if (at > 0 && /[A-Za-z0-9_.+@-]/.test(before[at - 1]!)) return null; // an email address, or the `@@` escape
  return { start: at + 1, query };
}

const rank = <T extends { label: string }>(items: T[], q: string, extra: (i: T) => string = () => ""): T[] => {
  const needle = q.toLowerCase();
  const score = (i: T) => {
    const l = i.label.toLowerCase();
    if (!needle || l.startsWith(needle)) return 0;
    if (extra(i).toLowerCase().startsWith(needle)) return 1;
    return l.includes(needle) ? 2 : 3;
  };
  return items.filter((i) => score(i) < 3).sort((a, b) => score(a) - score(b));
};

/** The options for what is typed after an `@`, filtered by it: first the service or storage, then (after the dot) its attribute. */
export function suggest(query: string, src: ReferenceSources): Suggestion[] {
  const dot = query.indexOf(".");
  if (dot < 0) {
    const targets: (Suggestion & { name: string })[] = [
      ...src.services.map((s) => ({ insert: `${s}.`, label: s, name: s, detail: "service", more: true })),
      ...src.peers.flatMap((p) => p.services.map((s) => ({ insert: `${p.app}/${s}.`, label: `${p.app}/${s}`, name: s, detail: "service of another app", more: true }))),
      ...src.storages.map((n) => ({ insert: `storage:${n}.`, label: `storage:${n}`, name: n, detail: "S3 storage", more: true })),
      { insert: "volume:shared.", label: "volume:shared", name: "shared", detail: "the app's shared directory", more: true },
      ...src.volumes.map((n) => ({ insert: `volume:${n}.`, label: `volume:${n}`, name: n, detail: "volume", more: true })),
    ];
    return rank(targets, query, (t) => t.name);
  }
  const target = query.slice(0, dot);
  const typed = query.slice(dot + 1);
  const attrs: { attr: string; detail: string }[] = target.startsWith("storage:")
    ? Object.entries(STORAGE_ATTRS).map(([attr, detail]) => ({ attr, detail }))
    : target.startsWith("volume:")
      ? Object.entries(VOLUME_ATTRS).map(([attr, detail]) => ({ attr, detail }))
      : [
        ...Object.entries(SERVICE_ATTRS).map(([attr, detail]) => ({ attr, detail })),
        ...(src.env[target] ?? []).map((attr) => ({ attr, detail: "variable" })),
      ];
  return rank(attrs.map((a) => ({ ...a, label: a.attr })), typed).map((a) => ({ insert: `${target}.${a.attr}`, label: a.attr, detail: a.detail, more: false }));
}
