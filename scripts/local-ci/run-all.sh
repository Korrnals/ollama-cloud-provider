#!/usr/bin/env bash
# Local CI runner — replicates .github/workflows/ci.yml gates.
# Exits non-zero if any gate fails. Prints a summary table at the end.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# Gate result arrays
GATE_NAMES=()
GATE_RESULTS=()  # "PASS" or "FAIL"
GATE_DETAILS=()

run_gate() {
  local name="$1"
  local script="$2"
  local out
  out="$("$script" 2>&1)"
  local rc=$?
  GATE_NAMES+=("$name")
  if [ "$rc" -eq 0 ]; then
    GATE_RESULTS+=("PASS")
    GATE_DETAILS+=("$(echo "$out" | tail -n 1)")
  else
    GATE_RESULTS+=("FAIL")
    GATE_DETAILS+=("$(echo "$out" | tail -n 3 | tr '\n' ' ' | sed 's/  */ /g')")
  fi
  # Stream output so the user sees progress
  echo "$out"
}

cd "$REPO_ROOT" || exit 1

echo "=== Local CI: running all gates ==="
echo

run_gate "Lint"               "$HERE/gate-lint.sh"
run_gate "Compile"            "$HERE/gate-compile.sh"
run_gate "Scope:application"  "$HERE/gate-scope-application.sh"
run_gate "No RCE"             "$HERE/gate-no-rce-primitives.sh"
run_gate "No webview/URI"     "$HERE/gate-no-webview-uri.sh"
run_gate "No telemetry"       "$HERE/gate-no-telemetry.sh"
run_gate "Secrets scan"       "$HERE/gate-secrets-scan.sh"
run_gate "npm audit"          "$HERE/gate-npm-audit.sh"
run_gate "Tests"              "$HERE/gate-test.sh"

# Summary table
echo
echo "╔══════════════════════════════════════════╗"
echo "║  Local CI Summary                        ║"
echo "╠══════════════════════════════════════════╣"
overall=0
for i in "${!GATE_NAMES[@]}"; do
  name="${GATE_NAMES[$i]}"
  res="${GATE_RESULTS[$i]}"
  # Pad name to 18 chars
  printf -v pname "%-18s" "$name"
  if [ "$res" = "PASS" ]; then
    mark="✅ PASS"
    echo "║  ${pname}  ${mark}               ║"
  else
    mark="❌ FAIL"
    echo "║  ${pname}  ${mark}               ║"
    overall=1
  fi
done
echo "╚══════════════════════════════════════════╝"

if [ "$overall" -ne 0 ]; then
  echo
  echo "FAIL: one or more gates failed. See output above."
  exit 1
fi
echo
echo "All gates passed."
exit 0