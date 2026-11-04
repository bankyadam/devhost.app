"""Smoke test without a microphone: text in → timing and WAV files out."""
import asyncio, json, sys, aiohttp

async def main(url: str, text: str, outdir: str):
    async with aiohttp.ClientSession() as s, s.ws_connect(url, max_msg_size=1 << 26) as ws:
        await ws.send_json({"type": "text", "text": text})
        n = 0
        async for m in ws:
            if m.type == aiohttp.WSMsgType.BINARY:
                open(f"{outdir}/s{n}.wav", "wb").write(m.data); n += 1
            else:
                d = json.loads(m.data); print(d)
                if d["type"] in ("done", "error"): break

asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
