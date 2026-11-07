import { appendFile, readFile } from "node:fs/promises";
import type { Deps } from "./deps.ts";
import { appDir } from "./releases.ts";

/** Where a deployed release came from, when it was not an uploaded artifact. */
export interface SourceMeta {
  type: "git";
  sha: string;
  ref: string;
  subject?: string;
  author?: string;
}

export interface HistoryEntry {
  at: string;
  action: "deploy" | "rollback";
  release: string;
  previous: string | null;
  result: "success" | "failed";
  reason?: string;
  source?: SourceMeta;
}

const historyFile = (d: Deps, app: string) => `${appDir(d, app)}/history.jsonl`;

export async function recordHistory(d: Deps, app: string, entry: Omit<HistoryEntry, "at">): Promise<HistoryEntry> {
  const full: HistoryEntry = { at: d.now().toISOString(), ...entry };
  await appendFile(historyFile(d, app), JSON.stringify(full) + "\n");
  return full;
}

export async function readHistory(d: Deps, app: string): Promise<HistoryEntry[]> {
  try {
    const text = await readFile(historyFile(d, app), "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryEntry);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
