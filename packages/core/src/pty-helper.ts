/**
 * Runs a command on a pseudo-terminal and speaks console frames (see protocol/console.ts) on its own stdin and stdout:
 * keystrokes in, output out, a resize frame changes the terminal's size, and the exit code is the last frame. Node has no
 * PTY of its own; Python's standard library does, and every server this runs on has it.
 *
 * Arguments: cols rows cwd command...
 */
export const PTY_HELPER = String.raw`
import errno, fcntl, os, select, signal, struct, sys, termios, time

cols, rows, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
argv = sys.argv[4:]

def frame(kind, payload=b""):
    return struct.pack(">BI", kind, len(payload)) + payload

def size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

master, slave = os.openpty()
size(master, cols, rows)
pid = os.fork()
if pid == 0:
    try:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        os.close(master)
        if slave > 2:
            os.close(slave)
        try:
            os.chdir(cwd)
        except OSError:
            os.chdir("/")
        os.execvp(argv[0], argv)
    except Exception as e:
        os.write(2, ("cannot start: %s\r\n" % e).encode())
    os._exit(127)
os.close(slave)
os.set_blocking(master, False)

def out(data):
    while data:
        data = data[os.write(1, data):]

pending = b""
inbuf = b""
stdin_open = True
code = None
deadline = None

def reap():
    global code
    if code is None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)

try:
    while True:
        reap()
        if code is not None and deadline is None:
            deadline = time.time() + 0.3
        if deadline is not None and time.time() > deadline:
            break
        reads = [master] + ([0] if stdin_open else [])
        writes = [master] if pending else []
        ready, can_write, _ = select.select(reads, writes, [], 0.2)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = None
            except OSError:
                break
            if data == b"":
                break
            if data:
                out(frame(0, data))
        if master in can_write and pending:
            try:
                n = os.write(master, pending)
                pending = pending[n:]
            except BlockingIOError:
                pass
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                stdin_open = False
                try:
                    os.killpg(pid, signal.SIGHUP)
                except OSError:
                    pass
                if deadline is None:
                    deadline = time.time() + 2
                continue
            inbuf += chunk
            while len(inbuf) >= 5:
                kind, length = struct.unpack(">BI", inbuf[:5])
                if len(inbuf) < 5 + length:
                    break
                payload = inbuf[5:5 + length]
                inbuf = inbuf[5 + length:]
                if kind == 0:
                    pending += payload
                elif kind == 1 and length == 4:
                    c, r = struct.unpack(">HH", payload)
                    size(master, max(c, 1), max(r, 1))
except BrokenPipeError:
    pass

if code is None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
    except OSError:
        code = 255
try:
    out(frame(2, struct.pack(">i", code)))
except OSError:
    pass
`;
