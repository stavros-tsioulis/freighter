import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, cliPath } from "./harness.ts";

describe("completion", () => {
  it("prints a script for each shell, naming the commands and their subcommands", async () => {
    const bash = await cli(["completion", "bash"]);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toContain("complete -F _freighter freighter");
    expect(bash.stdout).toMatch(/compgen -W "[^"]*\bdeploy\b[^"]*\bexec\b[^"]*"/);
    expect(bash.stdout).toMatch(/context\) COMPREPLY=.*list use show remove/);
    expect(bash.stdout).toMatch(/host\) COMPREPLY=.*token deploy unit haproxy certs app/);
    expect((await cli(["completion", "zsh"])).stdout).toContain("compdef _freighter freighter");
    expect((await cli(["completion", "fish"])).stdout).toContain("complete -c freighter");
    expect((await cli(["completion", "tcsh"])).status).toBe(2);
  });
});

describe("upgrade", () => {
  it("replaces the installed CLI with the one the control server serves", async () => {
    const served = Buffer.from(`// a newer CLI\n${"x".repeat(2000)}\n`);
    const server = createServer((req, res) => {
      if (req.url === "/cli/freighter.mjs") res.end(served);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const dir = mkdtempSync(join(tmpdir(), "freighter-cli-install-"));
      const installed = join(dir, "cli.mjs");
      copyFileSync(cliPath, installed);
      const run = (args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, [installed, ...args], { env: { ...process.env, FREIGHTER_URL: url, FREIGHTER_TOKEN: "fr_x", NO_COLOR: "1" } }, (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })));
      const r = await run(["upgrade"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Replaced");
      expect(readFileSync(installed)).toEqual(served);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("won't replace a copy it wasn't installed as, and says where the control server doesn't serve one", async () => {
    const lonely = await cli(["upgrade"], { env: { FREIGHTER_URL: "http://127.0.0.1:1", FREIGHTER_TOKEN: "fr_x" } });
    expect(lonely.status).toBe(1);
    expect(lonely.stderr).toContain("wasn't installed by the installer");
  });
});
