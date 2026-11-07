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

const UNIT_NAME = /^freighter-[a-z][a-z0-9-]*\.service$/;

export function assertUnitName(name: string): string {
  if (!UNIT_NAME.test(name)) throw new Error(`invalid unit name "${name}"`);
  return name;
}
