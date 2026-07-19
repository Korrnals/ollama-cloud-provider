#!/usr/bin/env bash
# Local release build — replicates .github/workflows/release.yml minus the
# CI-only signing steps (Sigstore cosign, GPG detached sign, SBOM, GitHub Release).
# Produces a VSIX + sha256.txt that a maintainer can sign/publish in CI.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

fail() { echo "[FAIL] $*"; exit 1; }

echo "=== Local release build ==="
echo

# 1. Install deps
if [ -f package-lock.json ]; then
  echo "[1/6] npm ci"
  npm ci || fail "npm ci failed"
else
  echo "[1/6] npm install (no lockfile)"
  npm install || fail "npm install failed"
fi

# 2. Lint
echo "[2/6] npm run lint"
npm run lint || fail "lint failed"

# 3. Compile
echo "[3/6] npm run compile"
npm run compile || fail "compile failed"

# 4. Security gates (same as run-all.sh)
echo "[4/6] security gates"
for g in gate-scope-application.sh gate-no-rce-primitives.sh gate-no-webview-uri.sh gate-no-telemetry.sh gate-secrets-scan.sh; do
  if ! "$HERE/$g" >/dev/null; then
    "$HERE/$g"
    fail "security gate $g failed"
  fi
done
echo "  all security gates passed"

# 5. Package VSIX
echo "[5/6] npm run package"
npm run package || fail "vsce package failed"

# 6. SHA256
echo "[6/6] sha256sum"
VSIX=$(ls *.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
  fail "no .vsix produced"
fi
sha256sum "$VSIX" > sha256.txt
SHA=$(awk '{print $1}' sha256.txt)

echo
echo "Local release build complete. VSIX: $VSIX, SHA256: $SHA"
echo
echo "NOTE: Sigstore (cosign) and GPG signing are CI-only steps."
echo "      For an official release, push a v* tag and let the GitHub"
echo "      Actions release.yml workflow sign and publish the VSIX."