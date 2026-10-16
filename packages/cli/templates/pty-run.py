#!/usr/bin/python3
"""Run a command on a pseudo-terminal: our stdin is typed into it, its output comes out on stdout.

devhost uses this to answer the questions `claude remote-control` asks on a terminal ("Trust <dir>?
[y/N]") when devhost itself has none (the desktop app over ssh, `--json`). BSD `script` cannot do
it: it fails with "tcgetattr/ioctl: Operation not supported on socket" when its stdin is one of
Node's pipes, which are sockets. The exit code is the command's (128 + n when a signal n ended it,
127 when it could not be started).

    pty-run.py <command> [args...]
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

if len(sys.argv) < 2:
    sys.stderr.write("usage: pty-run.py <command> [args...]\n")
    sys.exit(2)

pid, master = pty.fork()
if pid == 0:
    try:
        os.execvp(sys.argv[1], sys.argv[1:])
    except OSError as e:
        sys.stderr.write("%s: %s\n" % (sys.argv[1], e.strerror))
        os._exit(127)

# A terminal of a normal size: programs lay their output out for it.
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))


def forward(signum, _frame):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass


for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(s, forward)

stdin_open = True
while True:
    try:
        ready, _, _ = select.select([master] + ([0] if stdin_open else []), [], [])
    except InterruptedError:
        continue
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(master, data)
        else:
            stdin_open = False  # the writer is gone; the command may still be running
    if master in ready:
        try:
            data = os.read(master, 4096)
        except OSError:  # EIO: the command closed its side
            break
        if not data:
            break
        os.write(1, data)

_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
