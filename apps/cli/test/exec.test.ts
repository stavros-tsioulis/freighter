import { afterEach, describe, expect, it } from "vitest";
import { cli } from "./harness.ts";
import { startConsoleServer } from "./console-harness.ts";

let server: Awaited<ReturnType<typeof startConsoleServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("exec", () => {
  it("runs a command in the service, with its environment and secrets, and prints its output", async () => {
    server = await startConsoleServer();
    const r = await cli(["exec", "shop/web", "--", "/bin/sh", "-c", 'echo "mode=$MODE token=$TOKEN"'], { env: server.env });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mode=prod token=s3cret\n");
  });

  it("keeps standard output and error apart, and exits with the command's own exit code", async () => {
    server = await startConsoleServer();
    const r = await cli(["exec", "shop/web", "--", "/bin/sh", "-c", "echo out; echo err >&2; exit 7"], { env: server.env });
    expect(r.status).toBe(7);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect((await cli(["exec", "shop/web", "--", "/bin/sh", "-c", "exit 0"], { env: server.env })).status).toBe(0);
  });

  it("passes standard input with -i, and closes it when the input ends; without -i the command sees none", async () => {
    server = await startConsoleServer();
    const piped = await cli(["exec", "shop/web", "-i", "--", "/bin/sh", "-c", "tr a-z A-Z"], { env: server.env, input: "hello\n" });
    expect(piped.stdout).toBe("HELLO\n");
    const none = await cli(["exec", "shop/web", "--", "/bin/sh", "-c", "cat; echo done"], { env: server.env, input: "ignored\n" });
    expect(none.stdout).toBe("done\n");
  });

  it("adds variables for the command, and passes arguments exactly as they are", async () => {
    server = await startConsoleServer();
    const r = await cli(["exec", "shop/web", "-e", "GREETING=hi there", "--", "/bin/sh", "-c", 'echo "$GREETING" "$1"', "sh", "a  b; c"], { env: server.env });
    expect(r.stdout).toBe("hi there a  b; c\n");
  });

  it("says what is wrong: no command, no terminal for -t, a command that can't start, a service that isn't there", async () => {
    server = await startConsoleServer();
    expect((await cli(["exec", "shop/web"], { env: server.env })).status).toBe(2);
    const noTty = await cli(["exec", "shop/web", "-t", "--", "ls"], { env: server.env });
    expect(noTty.status).toBe(2);
    expect(noTty.stderr).toContain("-t needs a terminal");
    expect((await cli(["shell", "shop/web"], { env: server.env })).stderr).toContain("a shell needs a terminal");
    const missing = await cli(["exec", "shop/web", "--", "/no/such/command"], { env: server.env });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain("cannot start");
    const ghost = await cli(["exec", "shop/ghost", "--", "ls"], { env: server.env });
    expect(ghost.status).toBe(1);
    expect(ghost.stderr).toContain('unknown service "ghost"');
    expect((await cli(["exec", "shop", "--", "ls"], { env: server.env })).stderr).toContain("which service of shop");
  });

  it("is for admins, and every use is in the audit log by the command's name", async () => {
    server = await startConsoleServer();
    const denied = await cli(["exec", "shop/web", "--", "ls"], { env: { ...server.env, FREIGHTER_TOKEN: server.token("deployer") } });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("requires the admin role");
    await cli(["exec", "shop/web", "--", "/bin/sh", "-c", "echo secret-arg"], { env: server.env });
    const opened = server.registry.audit.list().filter((a) => a.action === "console.open");
    expect(opened.at(-1)!.detail).toMatchObject({ command: "sh", service: "web" });
    expect(JSON.stringify(opened)).not.toContain("secret-arg");
    expect(server.registry.audit.list().some((a) => a.action === "console.close")).toBe(true);
  });
});
