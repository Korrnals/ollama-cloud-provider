#!/usr/bin/env bash
# Gate: npm test
# Runs the full mocha test suite (unit + integration + e2e + race).
# Exits 0 if all tests pass, 1 otherwise.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

# Ensure the compiled output is up to date — tests run against out/.
# If compile fails, the gate fails before mocha runs.
if ! npm run compile >/tmp/local-ci-test-compile.log 2>&1; then
  echo "[FAIL] test (compile step failed before mocha)"
  echo "--- output (tail) ---"
  tail -n 20 /tmp/local-ci-test-compile.log
  exit 1
fi

if npm test >/tmp/local-ci-test.log 2>&1; then
  echo "[PASS] test (npm test)"
  # Surface the pass/fail counts for the summary table.
  grep -E "[0-9]+ passing|[0-9]+ failing" /tmp/local-ci-test.log | tail -n 2
  exit 0
else
  echo "[FAIL] test (npm test)"
  echo "--- output (tail) ---"
  tail -n 30 /tmp/local-ci-test.log
  exit 1
fi