"""
Parakeet-MLX transcription sidecar for Hydra — Apple Silicon (M1/M2/M3+).

Serves NVIDIA's Parakeet TDT (top of the Open ASR leaderboard for English) on
Apple's MLX runtime, so it runs natively and fast on Mac with no CUDA/NeMo and
no cloud. Same HTTP contract as the Canary sidecar (server.py):

    POST /transcribe   multipart/form-data, field `audio`  ->  {"text": "..."}
    GET  /health                                            ->  {"status": "ok", ...}

The model is loaded once at startup and reused. Incoming audio is resampled to
16 kHz mono WAV via ffmpeg before inference.

Run (on macOS, after ./setup.sh):
    .venv/bin/uvicorn server_mlx:app --host 127.0.0.1 --port 8123
or just: ../start-transcribe.sh parakeet   (auto-default on macOS)

Backend: https://github.com/senstella/parakeet-mlx
"""

import os
import shutil
import subprocess
import tempfile

from fastapi import FastAPI, UploadFile, File, HTTPException

MODEL_NAME = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")

app = FastAPI(title="Hydra Parakeet-MLX sidecar")

_model = None  # populated at startup


@app.on_event("startup")
def _startup() -> None:
    global _model
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH — required for audio resampling (brew install ffmpeg)")
    from parakeet_mlx import from_pretrained  # type: ignore

    print(f"[parakeet-mlx] loading {MODEL_NAME} ...", flush=True)
    _model = from_pretrained(MODEL_NAME)
    print("[parakeet-mlx] model ready", flush=True)


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
    assert _model is not None
    result = _model.transcribe(wav_path)
    # parakeet-mlx returns an aligned result object with a `.text` attribute.
    # Fall back to str(result) only when the attribute is missing — empty text
    # (silent audio) must yield "", not the object repr.
    text = getattr(result, "text", None)
    return (text if text is not None else str(result)).strip()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "backend": "parakeet-mlx", "loaded": _model is not None}


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
