#!/usr/bin/env bash
# Gate: scan src/ for common secret patterns. Must be empty.
# Patterns: sk-..., api_key="...", password="...", Bearer ...
# Excludes obvious test fixtures (files with "test" or "fixture" in the name).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

PATTERNS='sk-[a-zA-Z0-9]{20,}|api_key[[:space:]]*=[[:space:]]*["'\''][^"'\'']{10}|password[[:space:]]*=[[:space:]]*["'\''][^"'\'']{6}|Bearer[[:space:]]+[a-zA-Z0-9._-]{20,}'

# Find all source files, exclude test/fixture files
HITS=""
while IFS= read -r f; do
  base=$(basename "$f")
  case "$base" in
    *test*|*fixture*|*mock*) continue ;;
  esac
  m=$(grep -nE "$PATTERNS" "$f" 2>/dev/null || true)
  if [ -n "$m" ]; then
    HITS="${HITS}${f}:${m}"$'\n'
  fi
done < <(find src/ -type f 2>/dev/null)

if [ -n "$HITS" ]; then
  echo "[FAIL] secrets scan — potential secrets found in src/"
  echo "$HITS"
  exit 1
fi
echo "[PASS] secrets scan — no secret patterns found in src/"
exit 0