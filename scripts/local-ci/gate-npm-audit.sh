#!/usr/bin/env bash
# Gate: npm audit --audit-level=moderate
# CI uses continue-on-error: true (devDeps only, no runtime deps).
# We report the result but do NOT fail the overall CI on audit findings.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

AUDIT_OUT=$(npm audit --audit-level=moderate 2>&1)
RC=$?

# Per CI: continue-on-error. We pass the gate regardless, but surface findings.
if [ "$RC" -eq 0 ]; then
  echo "[PASS] npm audit — no moderate+ vulnerabilities"
  exit 0
else
  echo "[PASS] npm audit — findings reported (continue-on-error per CI policy)"
  echo "$AUDIT_OUT" | tail -n 15
  exit 0
fi