"""A long-lived `claude -p` process per voice connection: the ~8 s start-up is paid once, not per turn."""
import asyncio
import json
import os
from typing import AsyncIterator

VOICE_PROMPT = (
    "Voice mode. The user speaks to you and hears your answer read aloud. "
    "Reply in the language the user spoke (usually Hungarian), in a few short spoken sentences. "
    "No markdown, no lists, no code, no file paths in the spoken text: say what you did or found and "
    "keep code, commands and long output in files or tool results. "
    "The user's text is a speech-to-text transcript: code terms (useEffect, git rebase, dependency) "
    "may be misheard, correct them from context. "
    "Before anything destructive or hard to undo (delete, force push, overwrite), ask for a spoken yes first."
)


class ClaudeSession:
    def __init__(self, cwd: str, permission_mode: str = "default", session_id: str | None = None):
        self.cwd, self.permission_mode, self.session_id = cwd, permission_mode, session_id
        self.proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
                "--include-partial-messages", "--verbose", "--permission-mode", self.permission_mode,
                "--append-system-prompt", VOICE_PROMPT]
        if self.session_id:
            args += ["--resume", self.session_id]
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID")}
        self.proc = await asyncio.create_subprocess_exec(
            *args, cwd=self.cwd, env=env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=1 << 24)

    async def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            await self.proc.wait()

    async def turn(self, prompt: str) -> AsyncIterator[str]:
        """Send one user message, yield text deltas until the turn's result arrives."""
        async with self._lock:
            if not self.proc or self.proc.returncode is not None:
                await self.start()
            assert self.proc and self.proc.stdin and self.proc.stdout
            msg = {"type": "user", "message": {"role": "user", "content": prompt}}
            self.proc.stdin.write((json.dumps(msg) + "\n").encode())
            await self.proc.stdin.drain()
            async for line in self.proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                self.session_id = ev.get("session_id", self.session_id)
                t = ev.get("type")
                if t == "stream_event":
                    d = ev.get("event", {})
                    if d.get("type") == "content_block_delta" and d.get("delta", {}).get("type") == "text_delta":
                        yield d["delta"]["text"]
                elif t == "result":
                    return
