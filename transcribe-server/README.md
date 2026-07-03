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
So the only setup is getting the sidecar running:

```sh
# One-time: create the venv + install the right backend for your platform.
# Needs ffmpeg (brew install ffmpeg). Override the backend with an arg:
#    ./transcribe-server/setup.sh parakeet|canary
./transcribe-server/setup.sh
```

From then on the sidecar is **supervised with the daemon**: `hydra up`,
`start-daemon.sh`, and every watchdog tick call `start-transcribe.sh --auto`,
which starts it if (and only if) setup has been done, and never restarts a
running model server. `hydra down` stops it. To start it immediately without
touching the daemon, run `./start-transcribe.sh` yourself.

Supervision details:

- **One shared tmux session (`hydra-transcribe`) for all platforms** — the
  discord and slack daemons use the same model server; per-platform sessions
  would race for the same port.
- **A crashed server parks instead of exiting** (bad port, missing ffmpeg,
  failed model download): the session stays alive showing the error, so the
  watchdog can't respawn-with-model-load every 120s. Fix the cause, then
  `tmux kill-session -t hydra-transcribe` to let it restart.
- **The mock backend is never auto-supervised** — it runs manually (or with an
  explicit `HYDRA_TRANSCRIBE_AUTOSTART=1`), so leftover test config can't keep
  canned transcripts flowing into real messages.
- **A remote `HYDRA_TRANSCRIBE_URL` disables local autostart** — nothing to
  supervise on this machine.

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
| `HYDRA_TRANSCRIBE_AUTOSTART`   | unset (auto: start once set up)      | `1` → always autostart · `0` → never     |
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
