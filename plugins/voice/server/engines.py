"""Local speech engines: faster-whisper (STT) and Piper (TTS). Models load lazily, once."""
import io
import os
import wave

import numpy as np

# espeak-ng truncates long data paths: keep the link short (see ../SPIKE.md)
ESPEAK_LINK = os.environ.get("DEVHOST_VOICE_ESPEAK", "/tmp/devhost-espeak")


class Stt:
    def __init__(self, model: str = "small", language: str = "hu", vocab: str = ""):
        self.model_name, self.language, self.vocab = model, language, vocab
        self._m = None

    def transcribe(self, pcm16_16k: bytes) -> str:
        if self._m is None:
            from faster_whisper import WhisperModel
            self._m = WhisperModel(self.model_name, device="cpu", compute_type="int8", cpu_threads=8)
        audio = np.frombuffer(pcm16_16k, dtype=np.int16).astype(np.float32) / 32768.0
        segs, _ = self._m.transcribe(audio, language=self.language, beam_size=1,
                                     initial_prompt=self.vocab or None, vad_filter=True)
        return " ".join(s.text.strip() for s in segs).strip()


class Tts:
    def __init__(self, voice_path: str):
        self.voice_path = voice_path
        self._v = None

    def synthesize(self, text: str) -> bytes:
        """One sentence → a complete WAV file."""
        if self._v is None:
            import piper
            from piper import PiperVoice
            data = os.path.join(os.path.dirname(piper.__file__), "espeak-ng-data")
            if os.path.islink(ESPEAK_LINK) or os.path.exists(ESPEAK_LINK):
                os.remove(ESPEAK_LINK)
            os.symlink(data, ESPEAK_LINK)
            self._v = PiperVoice.load(self.voice_path, espeak_data_dir=ESPEAK_LINK)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            self._v.synthesize_wav(text, w)
        return buf.getvalue()
