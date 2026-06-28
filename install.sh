#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
CLI_SOURCE="${REPO_DIR}/cli/hydra.ts"

mkdir -p "$BIN_DIR"

ln -sf "$CLI_SOURCE" "${BIN_DIR}/hydra"
echo "installed: ${BIN_DIR}/hydra -> ${CLI_SOURCE}"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo "warning: ${BIN_DIR} is not on your PATH"
  echo "  add to ~/.zshrc: export PATH=\"\${HOME}/.local/bin:\${PATH}\""
fi
