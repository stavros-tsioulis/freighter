import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IDENT_RE, parseManifest } from "@freighter/manifest";
import { CliError, EXIT, usage } from "./errors.ts";

export interface Target {
  app: string;
  service?: string;
}

const ident = (what: string, v: string) => {
  if (!IDENT_RE.test(v)) throw usage(`"${v}" is not a valid ${what} name`, "names are lowercase letters, digits and hyphens");
  return v;
};

/** The `name:` of the `app.yaml` in a directory, or null if there isn't one. */
export function appNameIn(dir: string): string | null {
  const file = join(dir, "app.yaml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  try {
    return parseManifest(text, { legacy: true, raw: true }).name;
  } catch {
    return /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(text)?.[1] ?? null;
  }
}

/**
 * `shop` or `shop/web`. Without one, the app in the current directory (its `app.yaml`), so a command run in a project
 * needs no name. A service can only be named when an app is.
 */
export function target(arg: string | undefined, cwd = process.cwd()): Target {
  if (arg === undefined || arg === "") {
    const name = appNameIn(cwd);
    if (!name) throw usage("which app?", "name it (`freighter ps shop`), or run this where an app.yaml is");
    return { app: name };
  }
  const [app, service, ...rest] = arg.split("/");
  if (rest.length > 0) throw usage(`"${arg}" is not app or app/service`);
  return { app: ident("app", app!), ...(service === undefined ? {} : { service: ident("service", service) }) };
}

/** A target that has to name a service. */
export function serviceTarget(arg: string | undefined, cwd?: string): Target & { service: string } {
  const t = target(arg, cwd);
  if (!t.service) throw usage(`which service of ${t.app}?`, `name it as ${t.app}/<service>`);
  return t as Target & { service: string };
}

export interface RemotePath {
  /** The server or storage. */
  name: string;
  path: string;
}

/** `contabo-1:/etc/hosts`, `files:/photos/a.jpg`. A path always starts with `/`. */
export function remotePath(arg: string, what = "server"): RemotePath {
  const i = arg.indexOf(":");
  if (i <= 0 || !arg.slice(i + 1).startsWith("/")) throw usage(`"${arg}" is not ${what}:/path`);
  return { name: ident(what, arg.slice(0, i)), path: arg.slice(i + 1) };
}

/** True for `name:/path`, false for a path on this machine. */
export const isRemote = (arg: string): boolean => /^[a-z][a-z0-9-]*:\//.test(arg);

export const notFound = (message: string, hint?: string) => new CliError(message, EXIT.notFound, hint);
