#!/bin/bash
# One-time setup for the transcription sidecar. Picks the backend by platform:
#   macOS (Apple Silicon) -> Parakeet-MLX (server_mlx.py), light, no GPU.
#   else                  -> Canary-Qwen via NeMo (server.py), needs a CUDA GPU.
# Override with an arg: ./setup.sh parakeet | canary
# Needs Python 3.10+ and ffmpeg on PATH.
set -e

SRV_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SRV_DIR"

# Choose backend: arg wins, else platform default.
if [ -n "$1" ]; then
  BACKEND="$1"
elif [ "$(uname -s)" = "Darwin" ]; then
  BACKEND=parakeet
else
  BACKEND=canary
fi

case "$BACKEND" in
  parakeet) REQ=requirements-mlx.txt ;;
  canary)   REQ=requirements.txt ;;
  *) echo "unknown backend '$BACKEND' (use: parakeet|canary)"; exit 1 ;;
esac

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not found on PATH — required at runtime for audio resampling."
  echo "  macOS: brew install ffmpeg   |   Debian/Ubuntu: apt install ffmpeg"
fi

echo "Backend: $BACKEND  (deps: $REQ)"
echo "Creating venv at $SRV_DIR/.venv ..."
python3 -m venv .venv
./.venv/bin/pip install -U pip
echo "Installing dependencies ..."
./.venv/bin/pip install -r "$REQ"

echo
echo "Done. Start it now from the repo root:"
echo "    ./start-transcribe.sh"
echo "To keep it running via the watchdog, add to your daemon's .env:"
echo "    HYDRA_TRANSCRIBE_AUTOSTART=1"
