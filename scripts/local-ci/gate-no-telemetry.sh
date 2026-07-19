#!/usr/bin/env bash
# Gate: no telemetry / analytics / tracking patterns in src/*.ts (excluding comments).
# Replicates CI:
#   grep -rniE 'telemetry|analytics|tracking|phone.home' src/ --include='*.ts' | grep -v '// ' | grep -v '//'
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

HITS=$(grep -rniE 'telemetry|analytics|tracking|phone.home' src/ --include='*.ts' 2>/dev/null | grep -v '// ' | grep -v '//' || true)
if [ -n "$HITS" ]; then
  echo "[FAIL] no telemetry — telemetry/analytics patterns found in src/*.ts"
  echo "$HITS"
  exit 1
fi
echo "[PASS] no telemetry — no telemetry/analytics/tracking patterns in src/*.ts"
exit 0