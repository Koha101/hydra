#!/bin/bash
# DEPRECATED: use CHAT_PLATFORM=discord ./start-byte.sh
echo "DEPRECATED: use CHAT_PLATFORM=discord ./start-byte.sh" >&2
CHAT_PLATFORM="${CHAT_PLATFORM:-discord}" exec "$(dirname "$0")/start-byte.sh" "$@"
