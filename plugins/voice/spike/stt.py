import sys, time
import subprocess, numpy as np
from faster_whisper import WhisperModel
name, wav = sys.argv[1], sys.argv[2]
raw = subprocess.run(["ffmpeg","-v","quiet","-i",wav,"-f","s16le","-ac","1","-ar","16000","-"],capture_output=True).stdout
wav = np.frombuffer(raw,dtype=np.int16).astype(np.float32)/32768.0
t=time.time(); m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=12); load=time.time()-t
prompt = "Kódolásról szóló magyar beszéd angol kifejezésekkel: useEffect, git rebase, dependency, pull request, TypeScript."
for p in (None, prompt):
    t=time.time()
    segs,_ = m.transcribe(wav, language="hu", initial_prompt=p, beam_size=1)
    txt=" ".join(s.text.strip() for s in segs)
    print(name, "prompt" if p else "plain", f"load={load:.1f}s run={time.time()-t:.2f}s", "|", txt)
