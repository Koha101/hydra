#!/bin/bash
# One-time setup for the transcription sidecar. Picks the backend by platform:
#   macOS (Apple Silicon) -> Parakeet-MLX (server_mlx.py), light, no GPU.
#   else                  -> Canary-Qwen via NeMo (server.py), needs a CUDA GPU.
# Override with an arg: ./setup.sh parakeet | canary
#
# Needs Python >=3.10 and ffmpeg on PATH. If `uv` is installed it's used to
# provision Python 3.12 + the venv (no system Python needed); otherwise a
# system python>=3.10 is used.
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

VENV="$SRV_DIR/.venv"
echo "Backend: $BACKEND  (deps: $REQ)"
rm -rf "$VENV"

if [ "$BACKEND" = parakeet ]; then
  # MLX ships arm64-only wheels and needs a NATIVE arm64 Python — even on Apple
  # Silicon the shell often runs under Rosetta (x86_64), where mlx won't install.
  # So we explicitly use an arm64 Homebrew Python and build the venv with `arch -arm64`.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
    echo "ERROR: parakeet backend requires Apple Silicon (arm64) hardware."
    exit 1
  fi
  ARM_PY=""
  for c in /opt/homebrew/opt/python@3.13/bin/python3.13 \
           /opt/homebrew/opt/python@3.12/bin/python3.12 \
           /opt/homebrew/opt/python@3.11/bin/python3.11; do
    [ -x "$c" ] && { ARM_PY="$c"; break; }
  done
  if [ -z "$ARM_PY" ]; then
    if [ -x /opt/homebrew/bin/brew ]; then
      echo "Installing arm64 Python 3.12 via Homebrew ..."
      arch -arm64 /opt/homebrew/bin/brew install python@3.12
      ARM_PY=/opt/homebrew/opt/python@3.12/bin/python3.12
    else
      echo "ERROR: need arm64 Homebrew at /opt/homebrew to provision a native Python for MLX."
      echo "  Install Homebrew for Apple Silicon (https://brew.sh), then re-run."
      exit 1
    fi
  fi
  echo "Using arm64 Python: $ARM_PY ($(arch -arm64 "$ARM_PY" --version 2>&1))"
  arch -arm64 "$ARM_PY" -m venv "$VENV"
  "$VENV/bin/pip" install -U pip
  "$VENV/bin/pip" install -r "$REQ"

elif command -v uv >/dev/null 2>&1; then
  # canary on Linux/CUDA: uv fetches a managed CPython 3.12 if the host lacks one.
  echo "Using uv to provision Python 3.12 + venv at $VENV ..."
  uv venv --python 3.12 "$VENV"
  uv pip install --python "$VENV/bin/python" -r "$REQ"

else
  # Fallback: a system Python >= 3.10.
  PY=""
  for cand in python3.13 python3.12 python3.11 python3.10; do
    command -v "$cand" >/dev/null 2>&1 && { PY="$cand"; break; }
  done
  if [ -z "$PY" ] && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    PY=python3
  fi
  if [ -z "$PY" ]; then
    echo "ERROR: need Python >=3.10 (found $(python3 --version 2>&1)). Install uv or python@3.12."
    exit 1
  fi
  echo "Using $PY ($($PY --version 2>&1)) for the venv ..."
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -U pip
  "$VENV/bin/pip" install -r "$REQ"
fi

echo
echo "Done. Start it now from the repo root:"
echo "    ./start-transcribe.sh"
echo "To keep it running via the watchdog, add to your daemon's .env:"
echo "    HYDRA_TRANSCRIBE_AUTOSTART=1"
