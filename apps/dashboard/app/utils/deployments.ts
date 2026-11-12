import type { DeploymentRow } from "~/types";

/** The error of a deployment that was canceled starts like this (they are recorded as failed). */
const CANCELED = "Canceled by ";
export const isCanceled = (d: Pick<DeploymentRow, "status" | "error">) => d.status === "failed" && !!d.error?.startsWith(CANCELED);
/** The status to show: canceled is its own, otherwise the recorded one. */
export const shownStatus = (d: Pick<DeploymentRow, "status" | "error">) => (isCanceled(d) ? "canceled" : d.status);
/** Whether it can still be stopped. */
export const cancelable = (d: Pick<DeploymentRow, "status">) => d.status === "queued" || d.status === "running";
