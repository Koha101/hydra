#!/usr/bin/env bash
# Shared compile check — sourced by start-daemon.sh and preflight.sh.
# Caller must pass the source directory as $1.

_compile_check() {
  local rc=0
  local out=""
  for entry in daemon.ts bridge.ts; do
    err=$(cd "$1" && bun build "$entry" --target=bun 2>&1 >/dev/null) || rc=1
    [ -n "$err" ] && out="${out}[$entry] ${err}"$'\n'
  done
  echo "$out"
  return $rc
}
