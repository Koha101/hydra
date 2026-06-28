# Transcription sidecar (voice dictation)

Hydra transcribes inbound audio attachments (Discord voice notes, Slack audio
clips) to text so you can **dictate prompts** to Claude. The daemon downloads the
audio like any attachment, POSTs it to this sidecar, and merges the returned text
into the message Claude receives.

The default backend is **NVIDIA Canary-Qwen 2.5B** — top of the Hugging Face Open
ASR leaderboard for English accuracy (~5.6% WER), self-hosted so audio never
leaves your machine. The sidecar is just an HTTP endpoint, so any STT backend
that speaks the contract below works too.

## Contract

```
POST /transcribe   multipart/form-data, file field `audio`   ->  { "text": "..." }
GET  /health                                                  ->  { "status": "ok", ... }
```

## Packaged default

Transcription is **on by default on the daemon side**: whenever a sidecar is
reachable, voice notes are transcribed; when it isn't, audio just passes through.
So the only setup is getting the sidecar running. The model needs a one-time
install (GPU required) — after that the watchdog keeps it alive automatically.

```sh
# 1. One-time: create the venv and install NeMo (needs a CUDA GPU + ffmpeg)
./transcribe-server/setup.sh

# 2. Enable auto-start in your daemon's .env (see .env.example)
HYDRA_TRANSCRIBE_AUTOSTART=1

# 3. Start it now (the watchdog will keep it up from here on)
./start-transcribe.sh
```

First start downloads the model (~5 GB) and loads it into VRAM (~6 GB). When
`GET /health` reports `"loaded": true`, it's ready. Send a voice note — it
arrives to Claude as `[voice transcript] ...`. No daemon restart needed; the
daemon picks up the sidecar on the next audio message.

To disable dictation entirely, set `HYDRA_TRANSCRIBE_ENABLED=0`.

## Local testing without a GPU

`mock_server.py` implements the same contract with a canned response — use it to
verify the Hydra wiring (voice note → transcript → Claude) without NeMo:

```sh
python3 transcribe-server/mock_server.py      # 127.0.0.1:8123, pure stdlib
```

Smoke-test the contract directly:

```sh
curl -s localhost:8123/health
curl -s -F audio=@/path/to/clip.ogg localhost:8123/transcribe
# {"text":"This is a mock transcription from the Hydra sidecar."}
```

## Tuning

| Env (sidecar)             | Default                  | Purpose                              |
| ------------------------- | ------------------------ | ------------------------------------ |
| `CANARY_MODEL`            | `nvidia/canary-qwen-2.5b`| HF model id to load                  |
| `CANARY_MAX_NEW_TOKENS`   | `256`                    | Max tokens per transcription         |
| `HYDRA_MOCK_TRANSCRIPT`   | (canned text)            | mock_server.py response override     |

| Env (Hydra daemon)             | Default                              | Purpose                                  |
| ------------------------------ | ------------------------------------ | ---------------------------------------- |
| `HYDRA_TRANSCRIBE_ENABLED`     | unset (**on**)                       | set `0`/`false` to disable dictation     |
| `HYDRA_TRANSCRIBE_AUTOSTART`   | unset (off)                          | `1` → watchdog auto-starts the sidecar   |
| `HYDRA_TRANSCRIBE_BACKEND`     | `canary`                             | `canary` \| `mock` (used by start script)|
| `HYDRA_TRANSCRIBE_URL`         | `http://127.0.0.1:8123/transcribe`   | sidecar endpoint                         |
| `HYDRA_TRANSCRIBE_TIMEOUT_MS`  | `60000`                              | per-request timeout                      |
| `HYDRA_TRANSCRIBE_MAX_BYTES`   | `26214400` (25 MB)                   | skip audio larger than this              |

## Notes

- **Failure is non-fatal.** If the sidecar is down, slow, or errors, the daemon
  logs it and delivers the message without a transcript — dictation never blocks
  normal messages.
- **The original audio is preserved.** The downloaded audio file path still
  appears in `downloaded_files`, so Claude can inspect the raw audio if needed.
- **English-focused.** Canary-Qwen covers English best. For broad multilingual
  needs, point `CANARY_MODEL` at a multilingual NeMo model or swap the backend
  (e.g. Whisper/Qwen3-ASR) behind the same `/transcribe` contract.
