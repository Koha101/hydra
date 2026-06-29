# Transcription sidecar (voice dictation)

Hydra transcribes inbound audio attachments (Discord voice notes, Slack audio
clips) to text so you can **dictate prompts** to Claude. The daemon downloads the
audio like any attachment, POSTs it to this sidecar, and merges the returned text
into the message Claude receives.

Backends, by platform (`./start-transcribe.sh` and `setup.sh` pick automatically):

| Backend | Platform | Model | Server | Notes |
|---|---|---|---|---|
| **parakeet** | **macOS (Apple Silicon)** — default | Parakeet TDT 0.6B (MLX) | `server_mlx.py` | Native, ~50× realtime, ~6% English WER, no GPU. [senstella/parakeet-mlx](https://github.com/senstella/parakeet-mlx) |
| **canary** | Linux + NVIDIA GPU — default | Canary-Qwen 2.5B (NeMo) | `server.py` | ~5.6% English WER (Open ASR leaderboard #1); needs CUDA |
| **mock** | any | — | `mock_server.py` | GPU-free stub for testing the wiring |

All self-hosted — audio never leaves your machine. The sidecar is just an HTTP
endpoint, so any STT backend (e.g. a cloud API) that speaks the contract works too.

## Contract

```
POST /transcribe   multipart/form-data, file field `audio`   ->  { "text": "..." }
GET  /health                                                  ->  { "status": "ok", ... }
```

## Packaged default

Transcription is **on by default on the daemon side**: whenever a sidecar is
reachable, voice notes are transcribed; when it isn't, audio just passes through.
So the only setup is getting the sidecar running. After a one-time install the
watchdog keeps it alive automatically.

```sh
# 1. One-time: create the venv + install the right backend for your platform.
#    Needs ffmpeg (brew install ffmpeg). Override the backend with an arg:
#    ./transcribe-server/setup.sh parakeet|canary
./transcribe-server/setup.sh

# 2. Enable auto-start in your daemon's .env (see .env.example)
HYDRA_TRANSCRIBE_AUTOSTART=1

# 3. Start it now (the watchdog will keep it up from here on)
./start-transcribe.sh
```

First start downloads the model (Parakeet ~0.6 GB; Canary ~5 GB). When
`GET /health` reports `"loaded": true`, it's ready. Send a voice note — it
arrives to Claude as `[voice transcript] ...`. No daemon restart needed; the
daemon picks up the sidecar on the next audio message.

To disable dictation entirely, set `HYDRA_TRANSCRIBE_ENABLED=0`.

## Local testing without the model

`mock_server.py` implements the same contract with a canned response — use it to
verify the Hydra wiring (voice note → transcript → Claude) without any model:

```sh
./start-transcribe.sh mock                    # 127.0.0.1:8123, pure stdlib
```

Smoke-test the contract directly:

```sh
curl -s localhost:8123/health
curl -s -F audio=@/path/to/clip.ogg localhost:8123/transcribe
# {"text":"This is a mock transcription from the Hydra sidecar."}
```

## Tuning

| Env (sidecar)             | Default                          | Purpose                              |
| ------------------------- | -------------------------------- | ------------------------------------ |
| `PARAKEET_MODEL`          | `mlx-community/parakeet-tdt-0.6b-v3` | parakeet (MLX) model id          |
| `CANARY_MODEL`            | `nvidia/canary-qwen-2.5b`        | canary (NeMo) model id               |
| `CANARY_MAX_NEW_TOKENS`   | `256`                            | canary max tokens per transcription  |
| `HYDRA_MOCK_TRANSCRIPT`   | (canned text)                    | mock_server.py response override     |

| Env (Hydra daemon)             | Default                              | Purpose                                  |
| ------------------------------ | ------------------------------------ | ---------------------------------------- |
| `HYDRA_TRANSCRIBE_ENABLED`     | unset (**on**)                       | set `0`/`false` to disable dictation     |
| `HYDRA_TRANSCRIBE_AUTOSTART`   | unset (off)                          | `1` → watchdog auto-starts the sidecar   |
| `HYDRA_TRANSCRIBE_BACKEND`     | `parakeet` (macOS) / `canary`        | `parakeet` \| `canary` \| `mock`         |
| `HYDRA_TRANSCRIBE_URL`         | `http://127.0.0.1:8123/transcribe`   | sidecar endpoint                         |
| `HYDRA_TRANSCRIBE_TIMEOUT_MS`  | `60000`                              | per-request timeout                      |
| `HYDRA_TRANSCRIBE_MAX_BYTES`   | `26214400` (25 MB)                   | skip audio larger than this              |

## Notes

- **Failure is non-fatal.** If the sidecar is down, slow, or errors, the daemon
  logs it and delivers the message without a transcript — dictation never blocks
  normal messages.
- **The original audio is preserved.** The downloaded audio file path still
  appears in `downloaded_files`, so Claude can inspect the raw audio if needed.
- **English-focused.** Both Parakeet and Canary are tuned for English. For broad
  multilingual needs, point the model env at a multilingual variant (e.g.
  `PARAKEET_MODEL` at a multilingual Parakeet) or swap the backend (Whisper/
  Qwen3-ASR) behind the same `/transcribe` contract.
