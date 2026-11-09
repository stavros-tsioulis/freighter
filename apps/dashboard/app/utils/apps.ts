import type { AppRow } from "~/types";

/** An app that needs attention: its server lost it, or one of its services failed. */
export const troubled = (a: AppRow) => a.status === "missing" || a.services.some((s) => s.activeState === "failed");
