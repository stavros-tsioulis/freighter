/** Split a command line into argv. Supports single/double quotes and backslash escapes; no shell features. */
export function splitCommand(cmd: string): string[] {
  if (/[\r\n]/.test(cmd)) throw new Error("command must be a single line");
  const out: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inToken = true;
    } else if (c === " " || c === "\t") {
      if (inToken) out.push(cur);
      cur = "";
      inToken = false;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (quote) throw new Error("unterminated quote in command");
  if (inToken) out.push(cur);
  if (out.length === 0) throw new Error("empty command");
  return out;
}

function quoteArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  if (escaped === "" || /[\s"'\;]/.test(escaped)) {
    return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return escaped;
}

/** Build an ExecStart= value. `/usr/bin/env` gives systemd the absolute path it requires and resolves via PATH. */
export function toExecStart(argv: string[]): string {
  const first = argv[0]!;
  const cmd = first.startsWith("/") ? argv : ["/usr/bin/env", ...argv];
  return cmd.map(quoteArg).join(" ");
}
