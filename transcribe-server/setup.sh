#!/bin/bash
# One-time setup for the Canary-Qwen transcription sidecar.
# Creates a local venv and installs NeMo + FastAPI. Needs Python 3.10+, and a
# CUDA GPU for real-time transcription. ffmpeg must be on PATH.
set -e

SRV_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SRV_DIR"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not found on PATH — required at runtime for audio resampling."
  echo "  macOS: brew install ffmpeg   |   Debian/Ubuntu: apt install ffmpeg"
fi

echo "Creating venv at $SRV_DIR/.venv ..."
python3 -m venv .venv
./.venv/bin/pip install -U pip
echo "Installing dependencies (this is large — NeMo pulls in torch) ..."
./.venv/bin/pip install -r requirements.txt

echo
echo "Done. To enable auto-start, add to your daemon's .env:"
echo "    HYDRA_TRANSCRIBE_AUTOSTART=1"
echo "Then the watchdog will keep the sidecar running. Or start it now with:"
echo "    ./start-transcribe.sh   (from the repo root)"
