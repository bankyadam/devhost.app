# devhost-plugin-voice

Talk to Claude by voice and hear the answer read back: from a phone or desktop browser, fully private.

```
browser (PWA) ──WebSocket──► tailscale serve (HTTPS, tailnet only) ──► voice server on the host
                                                  faster-whisper (STT) → claude -p → sentence filter → Piper (TTS)
```

- **Private:** speech to text and text to speech run on the host; only Claude's API sees the text. Nothing is reachable outside the tailnet.
- **Spoken replies:** the voice session is told to answer in short sentences; code, paths and markdown are filtered out of the audio and stay on screen (`server/speech.py`).
- **Latency:** one long-lived `claude` process per connection (start-up overlaps with you speaking), sentence-by-sentence TTS. Measured on an Intel i7: first audio ~2.5 s on follow-up turns. See `SPIKE.md` for the engine measurements.

## Install

```sh
devhost plugin install ./plugins/voice --name voice --enable
devhost plugin run voice install        # venv, Hungarian Piper voice, LaunchDaemon, tailscale serve
devhost doctor                          # plugin.voice.service / plugin.voice.models
```

Options under `plugins.voice.options`: `port` (default `$DEVHOST_PORT_BASE + 90`), `voice` (Piper voice), `sttModel` (`small`), `language` (`hu`), `cwd`, `permissionMode`.

## Develop

```sh
python3.12 -m venv venv && venv/bin/pip install -r server/requirements.txt
venv/bin/python -m pytest server           # speech filter
venv/bin/python server/server.py --voice <path>.onnx --port 3010 --cwd .
npm test                                   # plugin
```

Pitfall: espeak-ng truncates long data paths; `engines.py` links its data dir at a short path.
