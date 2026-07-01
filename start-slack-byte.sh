#!/bin/bash
# DEPRECATED: use CHAT_PLATFORM=slack ./start-byte.sh
echo "DEPRECATED: use CHAT_PLATFORM=slack ./start-byte.sh" >&2
CHAT_PLATFORM="${CHAT_PLATFORM:-slack}" exec "$(dirname "$0")/start-byte.sh" "$@"
