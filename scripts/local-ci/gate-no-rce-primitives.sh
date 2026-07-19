#!/usr/bin/env bash
# Gate: no child_process / eval / new Function in src/.
# Replicates CI: grep -rnE 'child_process|require\(.child_process|new Function|eval\(' src/
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

HITS=$(grep -rnE 'child_process|require\(.child_process|new Function|eval\(' src/ 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "[FAIL] no RCE primitives — code execution primitives found in src/"
  echo "$HITS"
  exit 1
fi
echo "[PASS] no RCE primitives — no child_process / eval / Function in src/"
exit 0