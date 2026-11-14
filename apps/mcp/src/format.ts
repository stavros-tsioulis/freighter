import * as z from "zod/v4";
import { CHARACTER_LIMIT } from "./constants.ts";

export const ResponseFormat = z.enum(["markdown", "json"]).default("markdown").describe("'markdown' for readable text, 'json' for structured data");
export type ResponseFormatValue = z.infer<typeof ResponseFormat>;

export const Pagination = {
  limit: z.number().int().min(1).max(100).default(20).describe("Most items to return (1-100)"),
  offset: z.number().int().min(0).default(0).describe("How many items to skip, for the next page"),
};

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/** A result in the format asked for: JSON comes with the same data as structured content, markdown is text alone. */
export function respond(format: ResponseFormatValue, markdown: string, data: Record<string, unknown>): ToolResult {
  if (format === "json") return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  return text(markdown);
}

/** Plain text, cut from the front so the end (what just happened) stays: for logs and command output. */
export function tail(s: string, limit = CHARACTER_LIMIT): { text: string; truncated: boolean } {
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: `…(earlier output left out)\n${s.slice(s.length - limit)}`, truncated: true };
}

export interface ListOptions<T> {
  title: string;
  items: T[];
  limit: number;
  offset: number;
  format: ResponseFormatValue;
  /** One item as markdown. */
  line: (item: T) => string;
  empty: string;
  /** What to say, in the JSON, about the items (the key their list goes under). */
  key: string;
  json?: (item: T) => unknown;
}

/**
 * One page of a list, in either format, under the character limit: if it doesn't fit, fewer items are returned and
 * `next_offset` points at the first one left out, so nothing is cut in the middle of an item.
 */
export function listResult<T>(o: ListOptions<T>): ToolResult {
  const total = o.items.length;
  const slice = o.items.slice(o.offset, o.offset + o.limit);
  const render = (items: T[]) => {
    const next = o.offset + items.length;
    const hasMore = total > next;
    const data = { total, count: items.length, offset: o.offset, [o.key]: items.map(o.json ?? ((x) => x)), has_more: hasMore, ...(hasMore ? { next_offset: next } : {}) };
    if (o.format === "json") return { data, text: JSON.stringify(data, null, 2) };
    const lines = [`# ${o.title}`, `Showing ${items.length} of ${total}.`, "", items.map(o.line).join("\n\n")];
    if (hasMore) lines.push("", `More results: call again with offset=${next}.`);
    return { data, text: lines.join("\n") };
  };
  if (slice.length === 0) {
    const empty = o.offset >= total && total > 0 ? `Nothing at offset ${o.offset}: there are ${total}.` : o.empty;
    return o.format === "json" ? respond("json", "", { total, count: 0, offset: o.offset, [o.key]: [], has_more: false }) : text(empty);
  }
  let items = slice;
  let r = render(items);
  while (items.length > 1 && r.text.length > CHARACTER_LIMIT) {
    items = items.slice(0, Math.ceil(items.length / 2));
    r = render(items);
  }
  return o.format === "json" ? { content: [{ type: "text", text: r.text }], structuredContent: r.data } : text(r.text);
}

export const bytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};

/** `activating` + `auto-restart` is a crash that is being started again. */
export function stateOf(s: { activeState: string; subState: string }): string {
  if (s.activeState === "activating" && s.subState === "auto-restart") return "retrying";
  if (s.activeState === "active") return "running";
  if (s.activeState === "inactive") return "stopped";
  return s.activeState;
}

export const ok = text;
