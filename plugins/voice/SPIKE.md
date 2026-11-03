# Voice spike (phase 1)

Host: Intel i7 (6 cores / 12 threads), 32 GB, macOS 26. **Not Apple Silicon**, so MLX-Whisper is out.

## TTS: Piper, Hungarian (`hu_HU-anna-medium`, `hu_HU-imre-medium`)
- ~0.8 s for ~6 s of audio (real-time factor ~0.12) on CPU: fast enough to stream sentence by sentence.
- Pitfall: espeak-ng truncates its data path (fixed-size buffer). A long path such as a scratchpad dir fails with
  "Error processing file '.../phontab'". Pass `espeak_data_dir` as a **short path** (e.g. a symlink under `/tmp` or
  `~/.local/share/devhost/voice/espeak`).

## STT: faster-whisper (CTranslate2, int8, CPU), Hungarian with English code terms
Test sentence: "Átnéztem a useEffect hookot, és a hiba oka egy hiányzó dependency. Javítottam, a tesztek lefutnak." (~6.5 s)

| Model | Run time | Quality |
| --- | --- | --- |
| small | 4.4 s | poor on code terms |
| medium | 17.6 s | good, `initial_prompt` fixes `useEffect`/`dependency` |
| large-v3-turbo | 24–95 s | no better than medium here |

Conclusions:
- Only `small` is near interactive on this CPU (RTF ~0.7); `medium` and up are not.
- Mitigation: send the transcript to Claude marked as "voice transcript, code terms may be misheard" and let it correct
  from context; keep `initial_prompt` with project vocabulary.
- Transcribe during speech (VAD chunks) so the wait after the last word is short.
- To try in phase 2: whisper.cpp (ggml) as an alternative engine.
- faster-whisper 1.2.1 + the PyAV it pulled in fail on `av.open(metadata_errors=...)`: decode audio with ffmpeg to 16 kHz
  mono float32 and pass an array (the PWA sends 16 kHz PCM anyway).
