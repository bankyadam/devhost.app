"""Turn Claude's streamed markdown into sentences that are fit to be spoken.

Code, paths, URLs and markdown syntax stay on the screen; the voice only gets prose.
"""
import re

_FENCE = re.compile(r"```.*?(```|$)", re.S)
_INLINE = re.compile(r"`([^`\n]+)`")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+")
_PATH = re.compile(r"(?<!\w)(?:~|\.{1,2})?(?:/[\w.@+-]+){2,}/?")
_SENTENCE_END = re.compile(r"(?<=[.!?…:])\s+|\n{2,}")


def clean(text: str) -> str:
    """Strip everything that should not be read aloud."""
    text = _FENCE.sub(" ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("link", text)
    text = _PATH.sub("", text)
    # short inline identifiers are read as they are (useEffect), long snippets are dropped
    text = _INLINE.sub(lambda m: m.group(1) if len(m.group(1)) <= 24 and " " not in m.group(1) else "", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", text, flags=re.M)
    text = re.sub(r"[*_~>|]+", "", text)
    return re.sub(r"[ \t]+", " ", text).strip()


class SentenceStream:
    """Feed text deltas, get complete cleaned sentences as soon as they are done."""

    def __init__(self, min_len: int = 12):
        self.buf = ""
        self.pending = ""
        self.min_len = min_len

    def feed(self, delta: str) -> list[str]:
        self.buf += delta
        # an open code fence is held back until it closes
        if self.buf.count("```") % 2:
            return []
        parts = _SENTENCE_END.split(self.buf)
        self.buf = parts.pop()
        return self._emit(parts)

    def flush(self) -> list[str]:
        rest, self.buf = self.buf, ""
        return self._emit([rest], final=True)

    def _emit(self, parts: list[str], final: bool = False) -> list[str]:
        out: list[str] = []
        for p in parts:
            c = clean(p)
            if not c:
                continue
            self.pending = f"{self.pending} {c}".strip()
            if len(self.pending) >= self.min_len:
                out.append(self.pending)
                self.pending = ""
        if final and self.pending:
            out.append(self.pending)
            self.pending = ""
        return out
