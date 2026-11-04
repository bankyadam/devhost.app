"""Voice server: PCM in over a WebSocket → STT → Claude → sentences → TTS → WAV chunks out.

Protocol (client → server): binary frames of 16 kHz mono PCM16, then {"type":"end"}; or {"type":"text","text":...}
(server → client): {"type":"transcript"|"say"|"done"|"error", ...} and binary WAV frames, one per sentence.
"""
import argparse
import asyncio
import json
import time

from aiohttp import WSMsgType, web

from claude_runner import ClaudeSession
from engines import Stt, Tts
from speech import SentenceStream


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    app = request.app
    ws = web.WebSocketResponse(max_msg_size=1 << 26)
    await ws.prepare(request)
    pcm = bytearray()
    claude = ClaudeSession(app["cwd"], app["permission_mode"])
    loop = asyncio.get_running_loop()
    await claude.start()  # start-up overlaps with the user speaking

    async def turn(prompt: str) -> None:
        t0 = time.time()
        await ws.send_json({"type": "transcript", "text": prompt})
        stream, first = SentenceStream(), True
        async for delta in claude.turn(prompt):
            for s in stream.feed(delta):
                await say(s)
                if first:
                    first = False
                    await ws.send_json({"type": "latency", "first_audio_s": round(time.time() - t0, 2)})
        for s in stream.flush():
            await say(s)
        await ws.send_json({"type": "done", "session_id": claude.session_id})

    async def say(sentence: str) -> None:
        wav = await loop.run_in_executor(None, app["tts"].synthesize, sentence)
        await ws.send_json({"type": "say", "text": sentence})
        await ws.send_bytes(wav)

    async for msg in ws:
        try:
            if msg.type == WSMsgType.BINARY:
                pcm += msg.data
            elif msg.type == WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data["type"] == "end" and pcm:
                    audio, pcm = bytes(pcm), bytearray()
                    text = await loop.run_in_executor(None, app["stt"].transcribe, audio)
                    if text:
                        await turn(text)
                elif data["type"] == "text":
                    await turn(data["text"])
        except Exception as e:  # keep the socket alive; the client shows the error
            await ws.send_json({"type": "error", "message": str(e)})
    await claude.close()
    return ws


async def warm_up(app: web.Application) -> None:
    """Load both models now so the first spoken turn does not pay for it."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, app["tts"].synthesize, "Kész.")
    await loop.run_in_executor(None, app["stt"].transcribe, b"\0" * 32000)


def make_app(args: argparse.Namespace) -> web.Application:
    app = web.Application()
    app["cwd"], app["permission_mode"] = args.cwd, args.permission_mode
    app["stt"] = Stt(args.stt_model, args.language, args.vocab)
    app["tts"] = Tts(args.voice)
    app.on_startup.append(warm_up)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/health", lambda r: web.json_response({"ok": True}))
    return app


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=3000)
    p.add_argument("--cwd", default=".")
    p.add_argument("--voice", required=True, help="path to a Piper .onnx voice")
    p.add_argument("--stt-model", default="small")
    p.add_argument("--language", default="hu")
    p.add_argument("--vocab", default="Kódolásról szóló magyar beszéd: useEffect, git rebase, dependency, pull request, TypeScript.")
    p.add_argument("--permission-mode", default="default")
    a = p.parse_args()
    web.run_app(make_app(a), host=a.host, port=a.port)
