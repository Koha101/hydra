#!/bin/bash
# macOS-specific: ps eww shows process environment
# Shared orphan-byte reaper — sourced by start-byte-v2.sh and start-slack-byte.sh.
# Kills claude processes that are connected to the same daemon socket but have no
# HYDRA_SESSION_ID (i.e. they registered as 'main' and are likely duplicates).
#
# Requires: $SOCK (daemon socket path), $LOG (log file path)

_kill_orphan_bytes() {
  pgrep -f "claude.*--channels" 2>/dev/null | while read pid; do
    pinfo=$(ps eww -p "$pid" 2>/dev/null || true)
    if echo "$pinfo" | grep -q "DAEMON_SOCK=$SOCK" && \
       ! echo "$pinfo" | grep -q "HYDRA_SESSION_ID="; then
      echo "$(date): ${1} orphaned byte process $pid" >> "$LOG"
      kill ${2} "$pid" 2>/dev/null
    fi
  done
}
