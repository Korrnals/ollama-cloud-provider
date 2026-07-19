#!/usr/bin/env bash
# Gate: npm run compile
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

if npm run compile >/tmp/local-ci-compile.log 2>&1; then
  echo "[PASS] compile (npm run compile)"
  exit 0
else
  echo "[FAIL] compile (npm run compile)"
  echo "--- output (tail) ---"
  tail -n 20 /tmp/local-ci-compile.log
  exit 1
fi