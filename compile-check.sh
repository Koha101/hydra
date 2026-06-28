#!/usr/bin/env bash
# Shared compile check — sourced by start-daemon.sh and preflight.sh.
# Caller must pass the source directory as $1.

_compile_check() {
  local rc=0
  local out=""
  if [ -f "$1/node_modules/.bin/tsc" ] && [ -f "$1/tsconfig.json" ]; then
    err=$(cd "$1" && ./node_modules/.bin/tsc --noEmit 2>&1) || rc=1
    [ -n "$err" ] && out="${out}[tsc] ${err}"$'\n'
  else
    for entry in daemon.ts bridge.ts; do
      err=$(cd "$1" && bun build "$entry" --target=bun 2>&1 >/dev/null) || rc=1
      [ -n "$err" ] && out="${out}[$entry] ${err}"$'\n'
    done
  fi
  echo "$out"
  return $rc
}
