#!/usr/bin/env bash
# Ad-hoc codesign heapscope + LeakyVictim with the entitlements task_for_pid
# needs on modern macOS. Run once after every `swift build`. Idempotent.
#
#   heapscope     needs com.apple.security.cs.debugger (allow attach OUT)
#   LeakyVictim   needs com.apple.security.get-task-allow (allow attach IN)
#
# Both are required with SIP on: the caller-side entitlement isn't enough on
# its own, and Swift's auto-applied linker-signed ad-hoc signature no longer
# grants get-task-allow implicitly.

set -euo pipefail
cd "$(dirname "$0")"

sign_one() {
  local bin="$1"
  local ent="$2"
  if [ ! -x "$bin" ]; then
    echo "error: $bin not found — run 'swift build -c release' first" >&2
    exit 1
  fi
  if [ ! -f "$ent" ]; then
    echo "error: $ent not found" >&2
    exit 1
  fi
  codesign --force --sign - --entitlements "$ent" --options runtime "$bin"
  echo "signed: $bin"
}

sign_one ".build/release/heapscope"   "heapscope.entitlements"
sign_one ".build/release/LeakyVictim" "victim.entitlements"

echo ""
echo "entitlements now on disk:"
for b in .build/release/heapscope .build/release/LeakyVictim; do
  echo "  $b:"
  codesign -d --entitlements :- "$b" 2>/dev/null \
    | grep -oE '(com\.apple\.security\.cs\.debugger|com\.apple\.security\.get-task-allow)' \
    | sort -u \
    | sed 's/^/    - /'
done
