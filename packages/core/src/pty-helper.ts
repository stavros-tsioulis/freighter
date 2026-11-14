/**
 * Runs a command and speaks console frames (see protocol/console.ts) on its own stdin and stdout.
 *
 * `tty`: the command runs on a pseudo-terminal. Keystrokes in, output out, a resize frame changes the terminal's size.
 * `pipe`: the command runs on plain pipes, for `exec` without a terminal. Its standard output comes back as data frames
 * and its standard error as stderr frames; an eof frame closes its standard input.
 * Either way the exit code is the last frame. Node has no PTY of its own; Python's standard library does, and every
 * server this runs on has it.
 *
 * Arguments: mode cols rows cwd command...
 */
export const PTY_HELPER = String.raw`
import errno, fcntl, os, select, signal, struct, subprocess, sys, termios, time

mode, cols, rows, cwd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
argv = sys.argv[5:]

def frame(kind, payload=b""):
    return struct.pack(">BI", kind, len(payload)) + payload

def out(data):
    while data:
        data = data[os.write(1, data):]

def size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

def code_of(status):
    return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)

def read_frames(state, chunk):
    state["buf"] += chunk
    frames = []
    while len(state["buf"]) >= 5:
        kind, length = struct.unpack(">BI", state["buf"][:5])
        if len(state["buf"]) < 5 + length:
            break
        frames.append((kind, state["buf"][5:5 + length]))
        state["buf"] = state["buf"][5 + length:]
    return frames

def finish(code):
    try:
        out(frame(2, struct.pack(">i", code)))
    except OSError:
        pass
    sys.exit(0)

def run_tty():
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

    pending = b""
    state = {"buf": b""}
    stdin_open = True
    code = None
    deadline = None

    def reap():
        nonlocal code
        if code is None:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                code = code_of(status)

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
                for kind, payload in read_frames(state, chunk):
                    if kind == 0:
                        pending += payload
                    elif kind == 1 and len(payload) == 4:
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
            code = code_of(status)
        except OSError:
            code = 255
    finish(code)

def run_pipe():
    try:
        try:
            p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except NotADirectoryError:
            p = subprocess.Popen(argv, cwd="/", stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except FileNotFoundError:
            if os.path.isdir(cwd):
                raise
            p = subprocess.Popen(argv, cwd="/", stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as e:
        out(frame(5, ("cannot start: %s\n" % e).encode()))
        finish(127)
    sin, sout, serr = p.stdin.fileno(), p.stdout.fileno(), p.stderr.fileno()
    for fd in (sin, sout, serr):
        os.set_blocking(fd, False)
    pending = b""
    want_eof = False
    stdin_open = True
    helper_in = True
    state = {"buf": b""}
    open_out = {sout: 0, serr: 5}
    killed_at = None
    try:
        while open_out or p.poll() is None:
            reads = list(open_out) + ([0] if helper_in else [])
            writes = [sin] if (pending and stdin_open) else []
            ready, can_write, _ = select.select(reads, writes, [], 0.2)
            for fd in list(open_out):
                if fd in ready:
                    try:
                        data = os.read(fd, 65536)
                    except BlockingIOError:
                        continue
                    except OSError:
                        data = b""
                    if data == b"":
                        del open_out[fd]
                    else:
                        out(frame(open_out[fd], data))
            if sin in can_write and pending:
                try:
                    n = os.write(sin, pending)
                    pending = pending[n:]
                except BlockingIOError:
                    pass
                except (BrokenPipeError, OSError):
                    pending = b""
                    stdin_open = False
            if stdin_open and not pending and want_eof:
                try:
                    p.stdin.close()
                except OSError:
                    pass
                stdin_open = False
            if 0 in ready:
                chunk = os.read(0, 65536)
                if not chunk:
                    helper_in = False
                    try:
                        os.killpg(p.pid, signal.SIGHUP)
                    except OSError:
                        pass
                    killed_at = time.time()
                    continue
                for kind, payload in read_frames(state, chunk):
                    if kind == 0:
                        pending += payload
                    elif kind == 6:
                        want_eof = True
            if killed_at is not None and time.time() - killed_at > 2 and p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except OSError:
                    pass
                killed_at = time.time() + 3600
    except BrokenPipeError:
        pass
    code = p.poll()
    if code is None:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        code = p.wait()
    finish(128 + -code if code < 0 else code)

if mode == "pipe":
    run_pipe()
else:
    run_tty()
`;
