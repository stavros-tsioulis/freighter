import type { AppRow } from "~/types";

/** A service that crashed and is waiting for systemd to start it again. */
export const retrying = (s: { activeState: string; subState: string }) => s.activeState === "activating" && s.subState === "auto-restart";

/** An app that needs attention: its server lost it, or one of its services failed or keeps crashing. */
export const troubled = (a: AppRow) => a.status === "missing" || a.services.some((s) => s.activeState === "failed" || retrying(s));

/** What is wrong with a troubled app, in the words for its status: a failed service wins over one retrying. */
export const troubleLabel = (a: AppRow) => (a.services.some((s) => s.activeState === "failed") ? "Service failed" : "Service retrying");
