import { createInterface } from "node:readline/promises";
import { CliError, EXIT } from "./errors.ts";

export interface OutArgs {
  json?: boolean;
  quiet?: boolean;
  yes?: boolean;
  /** `--no-color` makes this false. */
  color?: boolean;
}

export interface Streams {
  out: { write(s: string): unknown; isTTY?: boolean };
  err: { write(s: string): unknown; isTTY?: boolean };
  /** Whether there is a person at the keyboard to ask. */
  interactive: boolean;
}

const ANSI = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", blue: "34", cyan: "36" } as const;
type Style = keyof typeof ANSI;

/** What a command writes to: results on standard output, everything else (progress, notes) on standard error. */
export class Out {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly yes: boolean;
  private readonly useColor: boolean;

  constructor(args: OutArgs = {}, private readonly streams: Streams = { out: process.stdout, err: process.stderr, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY }, env: NodeJS.ProcessEnv = process.env) {
    this.json = !!args.json;
    this.quiet = !!args.quiet;
    this.yes = !!args.yes;
    this.useColor = args.color !== false && !env.NO_COLOR && !!streams.out.isTTY && env.TERM !== "dumb";
  }

  get interactive(): boolean {
    return this.streams.interactive;
  }

  /** Wrap text in a style, when output goes to a terminal that shows color. */
  paint(style: Style, text: string): string {
    return this.useColor ? `\x1b[${ANSI[style]}m${text}\x1b[0m` : text;
  }

  /** A line of result, on standard output. */
  line(text = ""): void {
    this.streams.out.write(text + "\n");
  }

  /** A note for the person, on standard error. Nothing in `--quiet` or `--json` mode, which are for scripts. */
  note(text: string): void {
    if (!this.quiet && !this.json) this.streams.err.write(text + "\n");
  }

  warn(text: string): void {
    this.streams.err.write(`${this.paint("yellow", "warning:")} ${text}\n`);
  }

  /** One step of long work. Quiet in `--json` and `--quiet`, which want the result alone. */
  step(text: string): void {
    if (!this.json && !this.quiet) this.streams.err.write(`  ${text}\n`);
  }

  /** The result: JSON for `--json`, else whatever `text` prints. */
  data(value: unknown, text: () => void): void {
    if (this.json) this.line(JSON.stringify(value, null, 2));
    else text();
  }

  /** What a script wants from a command: one value per line with `--quiet`, the JSON with `--json`, else the text. */
  ids(values: string[], value: unknown, text: () => void): void {
    if (this.json) this.line(JSON.stringify(value, null, 2));
    else if (this.quiet) for (const v of values) this.line(v);
    else text();
  }

  /** Columns lined up under a heading. Empty cells show as `-`. */
  table(head: string[], rows: string[][]): void {
    const cell = (s: string | undefined) => (s === undefined || s === "" ? "-" : s);
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(cell(r[i])).length)));
    const fmt = (r: string[]) =>
      r
        .map((c, i) => {
          const text = cell(c);
          const pad = " ".repeat(Math.max(0, width[i]! - stripAnsi(text).length));
          return i === r.length - 1 ? text : text + pad;
        })
        .join("  ");
    this.line(this.paint("dim", fmt(head)));
    for (const r of rows) this.line(fmt(r));
  }

  /** `key  value` pairs, for one thing described. */
  facts(rows: [string, string | undefined][]): void {
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) if (v !== undefined && v !== "") this.line(`${this.paint("dim", k.padEnd(w))}  ${v}`);
  }

  /**
   * Ask before something that can't be undone. `--yes` answers for you; with nobody to ask, it refuses instead of
   * guessing. `typed` asks for a name to be typed, for the worst things.
   */
  async confirm(question: string, o: { typed?: string; verb?: string } = {}): Promise<void> {
    if (this.yes) return;
    if (!this.interactive) throw new CliError(`${question}: refusing to go on without asking`, EXIT.failed, "pass --yes to confirm in a script");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (o.typed) {
        const answer = (await rl.question(`${question}\nType ${o.typed} to ${o.verb ?? "confirm"}: `)).trim();
        if (answer !== o.typed) throw new CliError("the name didn't match; nothing was changed");
      } else {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") throw new CliError("cancelled; nothing was changed");
      }
    } finally {
      rl.close();
    }
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** `2m ago`, `3h ago`, `5d ago`; the date for anything older than a month. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return iso.slice(0, 10);
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Read a line without showing it (a token, a password), from the terminal or, when piped, from standard input. */
export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        }
        if (ch === "\x03") {
          done();
          return reject(new CliError("cancelled", EXIT.interrupted));
        }
        if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

/** Everything on standard input, for `--stdin`. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
