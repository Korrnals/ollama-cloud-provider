#!/usr/bin/env bash
# Gate: npm run lint
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

if npm run lint >/tmp/local-ci-lint.log 2>&1; then
  echo "[PASS] lint (npm run lint)"
  exit 0
else
  echo "[FAIL] lint (npm run lint)"
  echo "--- output (tail) ---"
  tail -n 20 /tmp/local-ci-lint.log
  exit 1
fi