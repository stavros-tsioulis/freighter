import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const real = () => readFileSync(cliPath);
  /** A control server that serves a CLI and (as the dashboard does) its checksum. */
  async function serve(bytes: Buffer, published = sha(bytes)) {
    const server = createServer((req, res) => {
      if (req.url === "/cli/freighter.mjs") res.end(bytes);
      else if (req.url === "/cli/freighter.mjs.sha256") res.end(`${published}\n`);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  /** An installed copy of the CLI, as the installer lays it down, run against a server. */
  function installed(url: string, bytes = real()) {
    const dir = mkdtempSync(join(tmpdir(), "freighter-cli-install-"));
    const path = join(dir, "cli.mjs");
    writeFileSync(path, bytes);
    const run = (args: string[], env: Record<string, string> = {}) =>
      new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
        execFile(process.execPath, [path, ...args], { env: { ...process.env, FREIGHTER_URL: url, FREIGHTER_TOKEN: "fr_x", FREIGHTER_CONFIG: join(dir, "config.json"), NO_COLOR: "1", ...env } }, (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })),
      );
    return { path, dir, run };
  }

  it("says it is up to date when it is, and what is newer when it isn't, without installing anything", async () => {
    const current = await serve(real());
    try {
      const a = installed(current.url);
      expect((await a.run(["upgrade"])).stdout).toContain("freighter is up to date");
      const json = JSON.parse((await a.run(["upgrade", "--json"])).stdout);
      expect(json).toMatchObject({ upToDate: true });
    } finally {
      await current.close();
    }
    const newer = Buffer.concat([real(), Buffer.from("\n// a newer build\n")]);
    const s = await serve(newer);
    try {
      const a = installed(s.url);
      const r = await a.run(["upgrade", "--check"]);
      expect(r.stdout).toMatch(/A newer freighter is available \(\w{7} -> \w{7}\)\. Run: freighter upgrade/);
      expect(JSON.parse((await a.run(["upgrade", "--check", "--json"])).stdout)).toMatchObject({ updateAvailable: true, latest: sha(newer) });
      expect(readFileSync(a.path)).toEqual(real()); // --check changes nothing
    } finally {
      await s.close();
    }
  });

  it("replaces itself with the one the server serves, keeps the old as .prev, and is then up to date", async () => {
    const newer = Buffer.concat([real(), Buffer.from("\n// a newer build\n")]);
    const s = await serve(newer);
    try {
      const a = installed(s.url);
      const r = await a.run(["upgrade"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Upgraded freighter \(\w{7} -> \w{7}\)/);
      expect(readFileSync(a.path)).toEqual(newer);
      expect(readFileSync(`${a.path}.prev`)).toEqual(real());
      expect(existsSync(a.path.replace(/\.mjs$/, ".new.mjs"))).toBe(false);
      expect((await a.run(["upgrade"])).stdout).toContain("freighter is up to date");
    } finally {
      await s.close();
    }
  });

  it("changes nothing when what arrives doesn't match its checksum, or doesn't start", async () => {
    const newer = Buffer.concat([real(), Buffer.from("\n// a newer build\n")]);
    const lying = await serve(newer, "f".repeat(64));
    try {
      const a = installed(lying.url);
      const r = await a.run(["upgrade"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("doesn't match the checksum");
      expect(readFileSync(a.path)).toEqual(real());
    } finally {
      await lying.close();
    }
    const broken = await serve(Buffer.from("this is not a program\n".repeat(100)));
    try {
      const a = installed(broken.url);
      const r = await a.run(["upgrade"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("did not start; nothing was changed");
      expect(readFileSync(a.path)).toEqual(real());
      expect(existsSync(a.path.replace(/\.mjs$/, ".new.mjs"))).toBe(false);
    } finally {
      await broken.close();
    }
  });

  it("won't replace a copy it wasn't installed as, and says where the control server doesn't serve one", async () => {
    const lonely = await cli(["upgrade"], { env: { FREIGHTER_URL: "http://127.0.0.1:1", FREIGHTER_TOKEN: "fr_x" } });
    expect(lonely.status).toBe(1);
    expect(lonely.stderr).toContain("wasn't installed by the installer");
    const none = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => none.listen(0, "127.0.0.1", r));
    try {
      const a = installed(`http://127.0.0.1:${(none.address() as AddressInfo).port}`);
      expect((await a.run(["upgrade"])).stderr).toContain("doesn't serve a CLI");
    } finally {
      await new Promise<void>((r) => none.close(() => r()));
    }
  });
});

describe("the update notice", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("looks in the background, then says once something newer is served, and only to a person at a terminal", async () => {
    const newer = Buffer.concat([readFileSync(cliPath), Buffer.from("\n// a newer build\n")]);
    const server = createServer((req, res) => (req.url === "/cli/freighter.mjs.sha256" ? res.end(`${sha(newer)}\n`) : res.writeHead(404).end()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const dir = mkdtempSync(join(tmpdir(), "freighter-cli-notice-"));
      const path = join(dir, "cli.mjs");
      copyFileSync(cliPath, path);
      const env = { ...process.env, FREIGHTER_URL: url, FREIGHTER_TOKEN: "fr_x", FREIGHTER_CONFIG: join(dir, "config.json"), FREIGHTER_UPDATE_CHECK: "1", NO_COLOR: "1" };
      const run = (args: string[], e: Record<string, string> = {}) => new Promise<{ stdout: string; stderr: string }>((resolve) => execFile(process.execPath, [path, ...args], { env: { ...env, ...e } }, (_err, stdout, stderr) => resolve({ stdout, stderr })));

      const first = await run(["context", "list"]);
      expect(first.stderr).not.toContain("newer freighter"); // nothing is known yet: the look happens behind this run
      const cache = join(dir, "update.json");
      for (let i = 0; i < 50 && !existsSync(cache); i++) await new Promise((r) => setTimeout(r, 100));
      expect(JSON.parse(readFileSync(cache, "utf8"))).toMatchObject({ url, latest: sha(newer) });

      const second = await run(["context", "list"]);
      expect(second.stderr).toMatch(/A newer freighter is available \(\w{7} -> \w{7}\)\. Run: freighter upgrade/);
      expect((await run(["context", "list", "--json"])).stderr).not.toContain("newer freighter"); // scripts are left alone
      expect((await run(["context", "list"], { FREIGHTER_NO_UPDATE_CHECK: "1" })).stderr).not.toContain("newer freighter");
      expect((await run(["upgrade", "--check"])).stderr).not.toContain("newer freighter"); // it says so itself
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
