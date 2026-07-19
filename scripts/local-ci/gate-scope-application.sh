#!/usr/bin/env bash
# Gate: all ollamaCloud.* config keys in package.json have scope: "application".
# Replicates the CI inline node check verbatim.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

OUT=$(node -e "
const pkg = require('./package.json');
const props = pkg.contributes?.configuration?.properties || {};
const violations = [];
for (const [key, val] of Object.entries(props)) {
  if (key.startsWith('ollamaCloud.') && val.scope !== 'application') {
    violations.push(key + ' has scope=' + (val.scope || 'undefined'));
  }
}
if (violations.length) {
  console.error('SECURITY GATE FAILED: config keys must be scope:application');
  violations.forEach(v => console.error('  ' + v));
  process.exit(1);
}
console.log('OK: all ollamaCloud.* config keys are scope:application');
" 2>&1)
RC=$?

if [ "$RC" -eq 0 ]; then
  echo "[PASS] scope:application — all ollamaCloud.* keys are application-scoped"
  exit 0
else
  echo "[FAIL] scope:application"
  echo "$OUT"
  exit 1
fi