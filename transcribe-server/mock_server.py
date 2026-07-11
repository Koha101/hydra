"""
Mock transcription sidecar — same HTTP contract as server.py, no model, no GPU.

Use this to verify Hydra's voice-dictation wiring end-to-end (send a voice note,
watch the daemon transcribe → deliver to Claude) without installing NeMo or
loading Canary-Qwen. It returns a fixed transcript for any audio it receives.

Run:
    python3 mock_server.py            # listens on 127.0.0.1:8123

Override the canned text with HYDRA_MOCK_TRANSCRIPT. Pure stdlib — no deps.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("HYDRA_MOCK_HOST", "127.0.0.1")
PORT = int(os.environ.get("HYDRA_MOCK_PORT", "8123"))
TRANSCRIPT = os.environ.get(
    "HYDRA_MOCK_TRANSCRIPT",
    "This is a mock transcription from the Hydra sidecar.",
)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok", "model": "mock", "loaded": True})
        else:
            self._json(404, {"detail": "not found"})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self._json(404, {"detail": "not found"})
            return
        # Drain the upload so the client sees a clean response; contents ignored.
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length:
            self.rfile.read(length)
        self._json(200, {"text": TRANSCRIPT})

    def log_message(self, *args) -> None:  # quieter logs
        pass


if __name__ == "__main__":
    print(f"[mock] transcription sidecar on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
