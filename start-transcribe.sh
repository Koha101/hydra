#!/bin/bash
# Ensure the voice-dictation transcription sidecar is running in a tmux session.
#
# Idempotent: a no-op if the session is already up, so it's safe for the
# watchdog to call every cycle (it will NOT restart a running model server).
#
# Backend selection (positional arg or HYDRA_TRANSCRIBE_BACKEND):
#   parakeet — Parakeet-MLX on Apple Silicon (server_mlx.py). Default on macOS.
#   canary   — NVIDIA Canary-Qwen 2.5B via NeMo (server.py). Default elsewhere; needs a CUDA GPU.
#   mock     — GPU-free stub for testing the wiring (mock_server.py).
# Both real backends need a one-time ./transcribe-server/setup.sh (creates .venv).
#
# The daemon picks the sidecar up automatically — no daemon restart needed.
export PATH="$HOME/.npm-global/bin:$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM:-discord}}}"

# Source state-dir .env for persistent config (backend, URL, etc.)
[ -f "$STATE_DIR/.env" ] && set -a && . "$STATE_DIR/.env" && set +a

# Default backend: parakeet (MLX) on macOS, canary (NeMo/CUDA) elsewhere.
if [ "$(uname -s)" = "Darwin" ]; then
  DEFAULT_BACKEND=parakeet
else
  DEFAULT_BACKEND=canary
fi

# Backend: positional arg wins (e.g. `./start-transcribe.sh mock`), else env, else default.
# Only known backends are accepted as the arg; anything else (e.g. a comment
# pasted from docs — zsh doesn't strip `#` in interactive mode) is ignored so a
# stray token can't silently pick a bogus backend.
BACKEND="${HYDRA_TRANSCRIBE_BACKEND:-$DEFAULT_BACKEND}"
case "${1:-}" in
  mock|canary|parakeet) BACKEND="$1" ;;
  '') ;;
  *) echo "start-transcribe: ignoring unrecognized arg '$1' (use: parakeet|canary|mock); using '$BACKEND'" >&2 ;;
esac
SESSION="${CHAT_PLATFORM:-discord}-transcribe"
LOG="${HYDRA_TRANSCRIBE_LOG:-$HOME/hydra-transcribe.log}"
SRV_DIR="$SCRIPT_DIR/transcribe-server"

# Derive the bind port from HYDRA_TRANSCRIBE_URL if set, else default 8123.
PORT=$(printf '%s' "${HYDRA_TRANSCRIBE_URL:-}" | sed -nE 's#.*://[^:/]+:([0-9]+).*#\1#p')
: "${PORT:=8123}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "$(date): ERROR: tmux not found in PATH" | tee -a "$LOG"
  exit 1
fi

# Already running — leave it alone.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Transcribe sidecar already running (tmux '$SESSION')."
  exit 0
fi

case "$BACKEND" in
  mock)
    CMD="python3 mock_server.py"
    ;;
  parakeet|canary)
    [ "$BACKEND" = parakeet ] && APP=server_mlx:app || APP=server:app
    VENV="$SRV_DIR/.venv"
    if [ ! -x "$VENV/bin/uvicorn" ]; then
      echo "$(date): $BACKEND backend not set up — run ./transcribe-server/setup.sh first. Skipping." | tee -a "$LOG"
      exit 1
    fi
    CMD="'$VENV/bin/uvicorn' $APP --host 127.0.0.1 --port $PORT"
    ;;
  *)
    echo "$(date): unknown HYDRA_TRANSCRIBE_BACKEND='$BACKEND' (expected parakeet|canary|mock)" | tee -a "$LOG"
    exit 1
    ;;
esac

tmux new-session -d -s "$SESSION" \
  "cd '$SRV_DIR' && HYDRA_MOCK_PORT=$PORT $CMD 2>&1 | tee -a '$LOG'"

echo "$(date): Transcribe sidecar started (backend=$BACKEND, port=$PORT, tmux '$SESSION')" >> "$LOG"
echo "Transcribe sidecar started (backend=$BACKEND, port=$PORT). Attach: tmux attach -t $SESSION"
