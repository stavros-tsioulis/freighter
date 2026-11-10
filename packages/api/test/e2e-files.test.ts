import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent, type RunningAgent } from "@freighter/agent";
import { makeDeps } from "@freighter/core/testing";
import { PkiStore } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";
import { toWebHandler } from "h3";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentDirectory, createApi } from "../src/index.ts";

let agent: RunningAgent | undefined;
afterEach(async () => agent?.close());

describe("end to end: browser -> API -> agent -> disk", () => {
  it("uploads, lists, downloads and zips real files, streaming", async () => {
    const host = await makeDeps();
    host.deps.dev = true;
    host.deps.config.agent.artifactsDir = `${host.root}/spool`;
    agent = await startAgent(host.deps, { socketPath: `${host.root}/run/agent.sock` });
    const registry = openRegistry(":memory:");
    const pki = new PkiStore(`${host.root}/pki`);
    const agents = await createAgentDirectory({ registry, localSocket: agent.socketPath, pki, timeoutMs: 30_000 });
    const api = createApi({ registry, pki, agents, artifactsDir: host.deps.config.agent.artifactsDir, maxUploadBytes: 1_000_000, trustProxy: false });
    const handler = toWebHandler(api.app);
    const token = registry.tokens.create({ name: "admin", role: "admin" }).token;
    const auth = { authorization: `Bearer ${token}` };
    const call = (path: string, init: RequestInit = {}) => handler(new Request(`http://x${path}`, { ...init, headers: { ...auth, ...(init.headers as object) } }));

    const dir = await mkdtemp(join(tmpdir(), "freighter-e2e-files-"));
    await mkdir(`${dir}/in`);
    const big = Buffer.alloc(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i);

    const up = await call(`/v1/servers/local/fs/upload?path=${encodeURIComponent(`${dir}/in/big.bin`)}`, { method: "PUT", body: big, headers: { "content-length": String(big.length) } });
    expect(up.status).toBe(200);
    expect(readFileSync(`${dir}/in/big.bin`).equals(big)).toBe(true);
    expect((await call(`/v1/servers/local/fs/upload?path=${encodeURIComponent(`${dir}/in/big.bin`)}`, { method: "PUT", body: "x", headers: { "content-length": "1" } })).status).toBe(409);
    expect(existsSync(`${dir}/in/.big.bin.freighter-upload`)).toBe(false);

    const list = (await (await call(`/v1/servers/local/fs?path=${encodeURIComponent(`${dir}/in`)}`)).json()) as { entries: { name: string; size: number }[] };
    expect(list.entries).toMatchObject([{ name: "big.bin", size: big.length }]);

    const dl = await call(`/v1/servers/local/fs/download?path=${encodeURIComponent(`${dir}/in/big.bin`)}`);
    expect(dl.headers.get("content-length")).toBe(String(big.length));
    expect(Buffer.from(await dl.arrayBuffer()).equals(big)).toBe(true);

    await writeFile(`${dir}/note.txt`, "note");
    const ticket = (await (await call("/v1/servers/local/fs/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [`${dir}/in`, `${dir}/note.txt`] }) })).json()) as { ticket: string };
    const zip = Buffer.from(await (await call(`/v1/servers/local/fs/archive/${ticket.ticket}`)).arrayBuffer());
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("in/big.bin"))).toBe(true);
    expect(zip.includes(Buffer.from("note.txt"))).toBe(true);

    const del = await call("/v1/servers/local/fs/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [`${dir}/in`, `${dir}/note.txt`] }) });
    expect(((await del.json()) as { done: string[] }).done).toHaveLength(2);
    expect(existsSync(`${dir}/in`)).toBe(false);
  });
});
