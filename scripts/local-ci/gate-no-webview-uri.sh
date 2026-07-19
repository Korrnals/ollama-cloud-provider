#!/usr/bin/env bash
# Gate: no webview or URI handler registration in src/.
# Replicates CI: grep -rnE 'createWebviewPanel|registerUriHandler|WebviewViewProvider' src/
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

HITS=$(grep -rnE 'createWebviewPanel|registerUriHandler|WebviewViewProvider' src/ 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "[FAIL] no webview/URI — webview or URI handler found in src/"
  echo "$HITS"
  exit 1
fi
echo "[PASS] no webview/URI — no createWebviewPanel / registerUriHandler / WebviewViewProvider in src/"
exit 0