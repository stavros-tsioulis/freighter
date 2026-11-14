import { execFile } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { cliPath } from "./harness.ts";
import { startConsoleServer } from "./console-harness.ts";

let server: Awaited<ReturnType<typeof startConsoleServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

// `freighter shell` needs a terminal on its own side, so it is run on a pseudo-terminal of a given size.
const ON_A_TERMINAL = `
import fcntl, os, pty, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.environ.update({"FREIGHTER_URL": sys.argv[2], "FREIGHTER_TOKEN": sys.argv[3], "NO_COLOR": "1"})
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[4]] + sys.argv[5:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 31, 97, 0, 0))
out = b""
def pump(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                return
            if not data:
                return
            out += data
pump(1.5)
os.write(fd, b'echo "mode=$MODE size=$(stty size)"\\n')
pump(1.0)
os.write(fd, b"exit 4\\n")
pump(1.5)
_, status = os.waitpid(pid, 0)
print("EXIT", os.WEXITSTATUS(status))
print(out.decode(errors="replace"))
`;

it("opens a shell in the service on the local terminal: its environment, its size, and the exit code", async () => {
  server = await startConsoleServer();
  const text = await new Promise<string>((resolve) => execFile("python3", ["-c", ON_A_TERMINAL, process.execPath, server!.env.FREIGHTER_URL, server!.env.FREIGHTER_TOKEN, cliPath, "shell", "shop/web"], { timeout: 30_000 }, (_e, so, se) => resolve(so + se)));
  expect(text).toMatch(/^EXIT 4$/m);
  expect(text).toContain("mode=prod size=31 97");
}, 40_000);
