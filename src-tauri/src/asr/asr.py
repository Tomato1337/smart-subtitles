import json, sys
import numpy as np
from faster_whisper import WhisperModel
# argv: model threads file...; each file is raw float32 little-endian mono 16 kHz PCM.
# Arrays, not paths: PyAV 19 rejects faster-whisper's open(metadata_errors=...).
model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=int(sys.argv[2]))
out = []
for path in sys.argv[3:]:
    audio = np.fromfile(path, dtype=np.float32)
    # No VAD on purpose: it drops the last words of a short cue window, and those words decide the clip end.
    segs, _ = model.transcribe(audio, language="en", word_timestamps=True, vad_filter=False, condition_on_previous_text=False)
    out.append([{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)} for s in segs for w in (s.words or [])])
print(json.dumps(out))
