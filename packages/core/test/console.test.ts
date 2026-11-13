import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { consolePlan, deploy, parseEnvFile, parseUnitEnvironment, setEnv, spawnConsole } from "../src/index.ts";
import { artifact, makeDeps } from "./helpers.ts";

// The wire format of the frames (see protocol/console.ts), spelled out here because core does not depend on the protocol.
const FRAME = { data: 0, resize: 1, exit: 2 };
interface Frame { type: number; payload: Buffer }
const encodeFrame = (type: number, payload: string | Buffer) => {
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from([type]), Buffer.from(new Uint8Array(new Uint32Array([body.length]).buffer).reverse()), body]);
};
const resizeFrame = (cols: number, rows: number) => {
  const p = Buffer.alloc(4);
  p.writeUInt16BE(cols, 0);
  p.writeUInt16BE(rows, 2);
  return encodeFrame(FRAME.resize, p);
};
const parseExit = (p: Buffer) => p.readInt32BE(0);
class FrameDecoder {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    while (this.buf.length >= 5 && this.buf.length >= 5 + this.buf.readUInt32BE(1)) {
      const n = this.buf.readUInt32BE(1);
      out.push({ type: this.buf[0]!, payload: this.buf.subarray(5, 5 + n) });
      this.buf = this.buf.subarray(5 + n);
    }
    return out;
  }
}

describe("what a unit sets for its process", () => {
  it("reads plain and quoted Environment lines, the files and the directory", () => {
    const unit = [
      "[Service]",
      "WorkingDirectory=/srv/apps/shop/releases/r1",
      "Environment=HOME=/srv/apps/shop/shared",
      'Environment="MODE=say \\"hi\\" 100%%"',
      "Environment=PORT=20001",
      "EnvironmentFile=-/etc/freighter/apps/shop/web.env",
      "EnvironmentFile=-/etc/freighter/apps/shop/web.refs.env",
    ].join("\n");
    expect(parseUnitEnvironment(unit)).toEqual({
      env: { HOME: "/srv/apps/shop/shared", MODE: 'say "hi" 100%', PORT: "20001" },
      files: ["/etc/freighter/apps/shop/web.env", "/etc/freighter/apps/shop/web.refs.env"],
      workingDirectory: "/srv/apps/shop/releases/r1",
    });
  });

  it("reads an env file as Freighter writes it", () => {
    expect(parseEnvFile('TOKEN="a\\"b\\\\c"\nEMPTY=""\nnot a line\n')).toEqual({ TOKEN: 'a"b\\c', EMPTY: "" });
  });
});

const MANIFEST = `name: shop
services:
  web:
    command: node web.mjs
    secrets: [TOKEN]
    environment:
      MODE: prod
`;

describe("the plan for a console", () => {
  it("runs a host service's shell as its user, where its unit runs, with its environment and secrets", async () => {
    const h = await makeDeps();
    await setEnv(h.deps, "shop", "web", "TOKEN", "s3cret");
    await deploy(h.deps, { manifestText: MANIFEST, source: await artifact() });
    const plan = await consolePlan(h.deps, "shop", "web");
    expect(plan).toMatchObject({ kind: "host", user: "shop" });
    expect(plan.argv.slice(0, 4)).toEqual(["runuser", "-u", "shop", "--"]);
    expect(plan.cwd).toContain("/srv/apps/shop/");
    expect(plan.env).toMatchObject({ MODE: "prod", TOKEN: "s3cret", TERM: "xterm-256color", USER: "shop", HOME: `${h.deps.layout.appsRoot}/shop/shared` });
    expect(plan.env.PATH).toBeTruthy();
    expect(Object.keys(plan.env)).not.toContain("FREIGHTER_PREFIX"); // none of the agent's own environment
  });

  it("execs into the running container for an image service", async () => {
    const h = await makeDeps();
    const { setEnv: set } = await import("../src/index.ts");
    await set(h.deps, "img", "web", "K", "v");
    await deploy(h.deps, { manifestText: "name: img\nservices:\n  web:\n    image: ghcr.io/org/app:1\n    port: 3000\n    secrets: [K]\n" });
    const plan = await consolePlan(h.deps, "img", "web");
    expect(plan.kind).toBe("container");
    expect(plan.argv).toEqual(expect.arrayContaining(["runuser", "-u", "img", "--", "/usr/bin/podman", "--cgroup-manager=cgroupfs", "exec", "-it"]));
    expect(plan.argv).toContain("freighter-img--web"); // the container is named like its unit
    expect(plan.env.XDG_RUNTIME_DIR).toBe("/run/freighter-img");
    expect(JSON.stringify(plan)).not.toContain('"v"'); // the container has its own environment: nothing is copied in
  });

  it("refuses an unknown service, one that is not running, and an app that was never deployed", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: MANIFEST.replace("secrets: [TOKEN]", ""), source: await artifact() });
    await expect(consolePlan(h.deps, "shop", "nope")).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/unknown service "nope"/) });
    await expect(consolePlan(h.deps, "ghost", "web")).rejects.toThrow(/not deployed/);
    const status = h.deps.systemd.status;
    h.deps.systemd.status = async (unit) => ({ ...(await status(unit)), activeState: "inactive", subState: "dead" }); // the fake host keeps everything running
    await expect(consolePlan(h.deps, "shop", "web")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/is not running/) });
  });
});

describe("the PTY helper", () => {
  const collect = async (child: Awaited<ReturnType<typeof spawnConsole>>, onFrame: (f: Frame) => void) => {
    const dec = new FrameDecoder();
    child.stdout!.on("data", (c: Buffer) => dec.push(c).forEach(onFrame));
    return new Promise<void>((resolve) => child.once("close", () => resolve()));
  };

  it("runs a command on a terminal: input, output, size and the exit code", async () => {
    const dir = await mkdtemp(`${tmpdir()}/fr-pty-`);
    const plan = { kind: "host" as const, user: "x", cwd: dir, shell: "sh", env: { PATH: process.env.PATH!, TERM: "xterm", GREETING: "hello" }, argv: ["/bin/sh", "-c", 'echo "$GREETING from $(pwd)"; stty size; read line; echo "got:$line"; stty size; exit 7'] };
    const child = await spawnConsole(plan, { cols: 100, rows: 30 });
    let output = "";
    let code: number | undefined;
    const done = collect(child, (f) => {
      if (f.type === FRAME.data) output += f.payload.toString();
      if (f.type === FRAME.exit) code = parseExit(f.payload);
    });
    await new Promise((r) => setTimeout(r, 400));
    child.stdin!.write(resizeFrame(120, 40));
    child.stdin!.write(encodeFrame(FRAME.data, "typed\n"));
    await done;
    expect(output).toContain(`hello from ${dir.replace(/^\/private/, "")}`.slice(0, 9));
    expect(output).toContain("30 100"); // the size it started with
    expect(output).toContain("got:typed");
    expect(output).toContain("40 120"); // and after the resize
    expect(code).toBe(7);
  });

  it("ends the shell when the connection goes away", async () => {
    const plan = { kind: "host" as const, user: "x", cwd: "/", shell: "sh", env: { PATH: process.env.PATH!, TERM: "xterm" }, argv: ["/bin/sh", "-c", "sleep 60"] };
    const child = await spawnConsole(plan, { cols: 80, rows: 24 });
    let code: number | undefined;
    const done = collect(child, (f) => {
      if (f.type === FRAME.exit) code = parseExit(f.payload);
    });
    await new Promise((r) => setTimeout(r, 300));
    child.stdin!.end();
    await done;
    expect(code).toBeGreaterThan(128); // ended by a signal, not left running
  }, 10_000);

  it("reports a command that cannot start", async () => {
    const plan = { kind: "host" as const, user: "x", cwd: "/", shell: "sh", env: { PATH: process.env.PATH!, TERM: "xterm" }, argv: ["/no/such/shell"] };
    const child = await spawnConsole(plan, { cols: 80, rows: 24 });
    let output = "";
    let code: number | undefined;
    await collect(child, (f) => {
      if (f.type === FRAME.data) output += f.payload.toString();
      if (f.type === FRAME.exit) code = parseExit(f.payload);
    });
    expect(output).toMatch(/cannot start/);
    expect(code).toBe(127);
  });
});
