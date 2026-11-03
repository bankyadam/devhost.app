import sys, time, wave, os
from piper import PiperVoice
d = "/tmp/espk-data"
v = PiperVoice.load(sys.argv[1], espeak_data_dir=d)
t=time.time()
with wave.open(sys.argv[3],"wb") as w:
    v.synthesize_wav(sys.argv[2], w)
print("tts s", round(time.time()-t,2))
