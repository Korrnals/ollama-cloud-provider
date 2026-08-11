#!/usr/bin/env bash
# Gate: npm audit --production --audit-level=moderate
# ArchCom 0011c (Security): made this a REAL gate. Previously exit 0
# always — security theatre. Now splits into:
#   1. Production audit (MUST pass — runtime deps)
#   2. Dev-only audit (report only — devDeps, not shipped)
# The extension ships zero runtime deps (all deps are devDependencies),
# so the production gate is trivially green — but it guards against
# future regressions if a runtime dep is ever added.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

# --- Production audit (MUST pass) ---
PROD_OUT=$(npm audit --omit=dev --audit-level=moderate 2>&1)
PROD_RC=$?

if [ "$PROD_RC" -ne 0 ]; then
  echo "[FAIL] npm audit (production) — moderate+ vulnerabilities in runtime deps:"
  echo "$PROD_OUT" | tail -n 20
  exit 1
fi
echo "[PASS] npm audit (production) — no moderate+ runtime vulnerabilities"

# --- Dev-only audit (report, do NOT fail) ---
DEV_OUT=$(npm audit --audit-level=moderate 2>&1)
DEV_RC=$?

if [ "$DEV_RC" -ne 0 ]; then
  echo "[INFO] npm audit (dev-only) — findings in devDependencies (not shipped):"
  echo "$DEV_OUT" | tail -n 10
fi

exit 0