import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createAgentClient, type AgentClient } from "@freighter/protocol";
import { makeDeps } from "@freighter/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startAgent, type RunningAgent } from "../src/index.ts";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

async function setup(files: { enabled?: boolean; readOnly?: boolean } = {}) {
  const h = await makeDeps();
  h.deps.config.agent.artifactsDir = `${h.root}/spool`;
  h.deps.config.agent.files = { enabled: files.enabled ?? true, readOnly: files.readOnly ?? false };
  h.deps.dev = true;
  agent = await startAgent(h.deps, { socketPath: `${h.root}/run/agent.sock` });
  const client: AgentClient = createAgentClient(agent.socketPath, { timeoutMs: 10_000 });
  const dir = await mkdtemp(join(tmpdir(), "freighter-fs-"));
  await mkdir(`${dir}/docs`);
  await writeFile(`${dir}/docs/a.txt`, "alpha");
  await writeFile(`${dir}/big.bin`, Buffer.alloc(3_000_000, 7));
  return { ...h, client, dir };
}
const drain = async (s: AsyncIterable<Buffer | string>) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
};

describe("file explorer over the agent protocol", () => {
  it("lists, makes folders, copies, moves, renames and deletes", async () => {
    const { client, dir } = await setup();
    expect((await client.call("fs.list", { path: dir })).entries.map((e) => e.name)).toEqual(["big.bin", "docs"]);
    await client.call("fs.mkdir", { path: `${dir}/new` });
    const copied = await client.call("fs.copy", { paths: [`${dir}/docs`, `${dir}/big.bin`], to: `${dir}/new` });
    expect(copied.done).toEqual([`${dir}/new/docs`, `${dir}/new/big.bin`]);
    expect((await client.call("fs.copy", { paths: [`${dir}/big.bin`], to: `${dir}/new` })).failed[0]!.error).toMatch(/already exists/);
    expect((await client.call("fs.rename", { path: `${dir}/new/docs`, name: "papers" })).path).toBe(`${dir}/new/papers`);
    await client.call("fs.move", { paths: [`${dir}/new/papers`], to: `${dir}` });
    expect(existsSync(`${dir}/papers/a.txt`)).toBe(true);
    execFileSync("tar", ["-czf", `${dir}/docs.tar.gz`, "-C", dir, "docs"]);
    const unpacked = await client.call("fs.extract", { paths: [`${dir}/docs.tar.gz`] });
    expect(unpacked.done).toEqual([`${dir}/docs copy`]); // `docs` is taken, so the default is to keep both
    expect(existsSync(`${dir}/docs copy/docs/a.txt`)).toBe(true);
    const gone = await client.call("fs.delete", { paths: [`${dir}/new`, `${dir}/missing`] });
    expect(gone.done).toEqual([`${dir}/new`]);
    expect(gone.failed).toHaveLength(1);
    await expect(client.call("fs.list", { path: `${dir}/nope` })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.call("fs.list", { path: "relative" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("uploads a file of any size, refusing what exists unless told to overwrite", async () => {
    const { client, dir } = await setup();
    const payload = Buffer.alloc(5_000_000, 3);
    await client.writeFile({ path: `${dir}/up.bin`, size: payload.length, overwrite: false }, Readable.from([payload]));
    expect((await readFile(`${dir}/up.bin`)).equals(payload)).toBe(true);
    await expect(client.writeFile({ path: `${dir}/up.bin`, size: 3, overwrite: false }, Readable.from([Buffer.from("abc")]))).rejects.toMatchObject({ code: "conflict" });
    await client.writeFile({ path: `${dir}/up.bin`, size: 3, overwrite: true }, Readable.from([Buffer.from("abc")]));
    expect(await readFile(`${dir}/up.bin`, "utf8")).toBe("abc");
    await client.writeFile({ path: `${dir}/empty`, size: 0, overwrite: false }, Readable.from([]));
    expect(existsSync(`${dir}/empty`)).toBe(true);
    await expect(client.writeFile({ path: `${dir}/nope/x`, size: 3, overwrite: false }, Readable.from([Buffer.from("abc")]))).rejects.toMatchObject({ code: "not_found" });
    expect(existsSync(`${dir}/nope`)).toBe(false);
  });

  it("downloads a file and streams a zip of several paths", async () => {
    const { client, dir } = await setup();
    const { result, body } = await client.openStream("fs.read", { path: `${dir}/big.bin` });
    expect(result.size).toBe(3_000_000);
    expect((await drain(body)).equals(Buffer.alloc(3_000_000, 7))).toBe(true);
    await expect(client.openStream("fs.read", { path: `${dir}/docs` })).rejects.toMatchObject({ code: "bad_request" });
    await expect(client.openStream("fs.read", { path: `${dir}/ghost` })).rejects.toMatchObject({ code: "not_found" });

    const zip = await client.openStream("fs.archive", { paths: [`${dir}/docs`, `${dir}/big.bin`] });
    const bytes = await drain(zip.body);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(bytes.includes(Buffer.from("docs/a.txt"))).toBe(true);
  });

  it("can be turned off, or limited to looking and downloading", async () => {
    const off = await setup({ enabled: false });
    await expect(off.client.call("fs.list", { path: off.dir })).rejects.toThrow(/turned off/);
    await expect(off.client.openStream("fs.read", { path: `${off.dir}/big.bin` })).rejects.toThrow(/turned off/);
    expect((await off.client.call("ping", {})).capabilities).not.toContain("files");
    await agent!.close();

    const ro = await setup({ readOnly: true });
    expect((await ro.client.call("fs.list", { path: ro.dir })).entries.length).toBe(2);
    await expect(ro.client.call("fs.mkdir", { path: `${ro.dir}/x` })).rejects.toThrow(/read-only/);
    await expect(ro.client.call("fs.delete", { paths: [`${ro.dir}/big.bin`] })).rejects.toThrow(/read-only/);
    await expect(ro.client.writeFile({ path: `${ro.dir}/u`, size: 1, overwrite: false }, Readable.from([Buffer.from("x")]))).rejects.toThrow(/read-only/);
    const opened = await ro.client.openStream("fs.read", { path: `${ro.dir}/big.bin` });
    expect(opened.result.size).toBe(3_000_000);
    opened.body.destroy();
  });

  it("reports the machine for the monitoring page", async () => {
    const { client } = await setup();
    const status = await client.call("host.status", {});
    expect(status.cpus).toBeGreaterThan(0);
    expect(status.os).toMatch(/\w+ .+ \w+/);
    expect(status.files).toEqual({ enabled: true, readOnly: false });
    expect((await client.call("ping", {})).capabilities).toContain("files");
  });
});
