"""
Canary-Qwen transcription sidecar for Hydra.

Serves NVIDIA Canary-Qwen 2.5B (top of the Hugging Face Open ASR leaderboard for
English accuracy, ~5.6% WER) over a tiny HTTP contract that Hydra's daemon calls:

    POST /transcribe   multipart/form-data, field `audio`  ->  {"text": "..."}
    GET  /health                                            ->  {"status": "ok", ...}

The model is loaded once at startup and reused. Incoming audio (Discord voice
notes are ogg/opus, Slack clips are m4a/mp3) is resampled to 16 kHz mono WAV via
ffmpeg before inference, which is what the NeMo model expects.

Run:
    pip install -r requirements.txt          # needs a CUDA GPU for real-time speed
    uvicorn server:app --host 127.0.0.1 --port 8123

Then in Hydra's .env:
    HYDRA_TRANSCRIBE_ENABLED=1
    HYDRA_TRANSCRIBE_URL=http://127.0.0.1:8123/transcribe

No GPU handy? Use mock_server.py to exercise the Hydra wiring end-to-end without
loading the model.
"""

import os
import shutil
import subprocess
import tempfile

from fastapi import FastAPI, UploadFile, File, HTTPException

MODEL_NAME = os.environ.get("CANARY_MODEL", "nvidia/canary-qwen-2.5b")
MAX_NEW_TOKENS = int(os.environ.get("CANARY_MAX_NEW_TOKENS", "256"))

app = FastAPI(title="Hydra Canary-Qwen sidecar")

_model = None  # lazy-checked; populated at startup


def _load_model():
    """Load Canary-Qwen via NeMo. Imported lazily so the module imports cheaply."""
    from nemo.collections.speechlm2.models import SALM  # type: ignore

    model = SALM.from_pretrained(MODEL_NAME)
    model.eval()
    return model


@app.on_event("startup")
def _startup() -> None:
    global _model
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH — required for audio resampling")
    print(f"[canary] loading {MODEL_NAME} ...", flush=True)
    _model = _load_model()
    print("[canary] model ready", flush=True)


def _to_wav16k_mono(src_path: str) -> str:
    """Resample arbitrary audio to 16 kHz mono 16-bit WAV via ffmpeg."""
    dst_path = src_path + ".16k.wav"
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", src_path,
         "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst_path],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', 'replace')[-500:]}")
    return dst_path


def _transcribe(wav_path: str) -> str:
    """Run Canary-Qwen in ASR mode on a prepared 16 kHz mono WAV."""
    assert _model is not None
    prompt = [[{
        "role": "user",
        "content": f"Transcribe the following: {_model.audio_locator_tag}",
        "audio": [wav_path],
    }]]
    answer_ids = _model.generate(prompts=prompt, max_new_tokens=MAX_NEW_TOKENS)
    return _model.tokenizer.ids_to_text(answer_ids[0].cpu()).strip()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict:
    if _model is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    suffix = os.path.splitext(audio.filename or "")[1] or ".bin"
    tmp_in = wav_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            f.write(await audio.read())
            tmp_in = f.name
        wav_path = _to_wav16k_mono(tmp_in)
        text = _transcribe(wav_path)
        return {"text": text}
    except Exception as err:  # surface as 500 so the client logs + skips, never blocks
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        for p in (tmp_in, wav_path):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
