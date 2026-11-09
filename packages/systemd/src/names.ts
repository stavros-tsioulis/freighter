import { IDENT_RE as IDENT } from "@freighter/manifest";

export function assertIdent(kind: string, value: string): string {
  if (!IDENT.test(value)) throw new Error(`invalid ${kind} "${value}": must match ${IDENT}`);
  return value;
}

export interface UnitRef {
  app: string;
  service: string;
  /** Release id; lets two versions of one service run side by side (phase 3). */
  instance?: string;
}

export function unitName({ app, service, instance }: UnitRef): string {
  // "--" separates the parts; idents never contain it, so (app, service, instance) -> name is unambiguous.
  const parts = [assertIdent("app", app), assertIdent("service", service)];
  if (instance !== undefined) parts.push(assertIdent("instance", instance));
  return `freighter-${parts.join("--")}.service`;
}

const UNIT_NAME = /^(freighter-[a-z][a-z0-9-]*\.service|[A-Za-z0-9:_.\\-]+\.mount)$/;

/** systemd's name for a path (`systemd-escape --path`): `/` becomes `-`, anything but [A-Za-z0-9:_.] becomes `\xNN`. */
export function escapePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "").replace(/^\/+/, "");
  if (trimmed === "") return "-";
  return [...trimmed]
    .map((c, i) => {
      if (c === "/") return "-";
      if (/[A-Za-z0-9:_]/.test(c) || (c === "." && i > 0)) return c;
      return [...Buffer.from(c)].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
    })
    .join("");
}

/** The mount unit for a directory: systemd requires it to be named after the path. */
export const mountUnitName = (dir: string) => `${escapePath(dir)}.mount`;

export function assertUnitName(name: string): string {
  if (!UNIT_NAME.test(name)) throw new Error(`invalid unit name "${name}"`);
  return name;
}
