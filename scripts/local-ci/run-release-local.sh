#!/usr/bin/env bash
# Local release pipeline — full replication of .github/workflows/release.yml
# run on a maintainer laptop. GitHub Actions is blocked by account billing
# (issue #1), so this script performs every step locally:
#
#   1. Pre-release validation (all CI gates)
#   2. Build VSIX (npm ci → lint → compile → vsce package)
#   3. Compute SHA256                 (L1 — integrity, REQUIRED)
#   4. Sigstore cosign sign-blob      (L2 — build provenance, OPTIONAL)
#   5. GPG detached-sign checksums    (L3 — identity, REQUIRED)
#   6. SBOM (syft if present, else minimal SPDX-JSON fallback)
#   7. Create annotated git tag (no push yet)
#   8. Generate release notes (gh or git log fallback)
#   9. Create GitHub Release + upload artifacts (gh)
#  10. Push tag to origin
#
# Usage:
#   ./scripts/local-ci/run-release-local.sh             # version from package.json
#   ./scripts/local-ci/run-release-local.sh v0.2.0      # explicit version
#   ./scripts/local-ci/run-release-local.sh --dry-run   # print plan, do nothing
#
# Signing layers:
#   L1 SHA256      — always (integrity)
#   L2 Sigstore    — optional, degrades with warning if cosign missing
#   L3 GPG         — required; uses env vars GPG_PRIVATE_KEY/GPG_PASSPHRASE
#                    or an already-imported key in the gpg keyring
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

# ─── Colour helpers ────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m';  C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_RESET=""
fi

ok()    { echo "${C_GREEN}✓${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}⚠${C_RESET} $*"; }
err()   { echo "${C_RED}✗${C_RESET} $*" >&2; }
step()  { echo "${C_BLUE}→${C_RESET} ${C_BOLD}Step $1:${C_RESET} $2"; }
fail()  { err "FAILED at step $1: $2"; exit 1; }

# ─── Dry-run mode ──────────────────────────────────────────────────────────
DRY_RUN=0
ARG_VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) ARG_VERSION="$arg" ;;
  esac
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "${C_BOLD}=== DRY RUN — no mutations will be performed ===${C_RESET}"
  echo
fi

# ─── Resolve version ───────────────────────────────────────────────────────
if [ -n "$ARG_VERSION" ]; then
  VERSION_RAW="$ARG_VERSION"
else
  VERSION_RAW="$(node -p "require('./package.json').version")"
fi
VERSION_NUM="${VERSION_RAW#v}"
VERSION="v${VERSION_NUM}"

echo "${C_BOLD}Release target:${C_RESET} $VERSION (package.json: $(node -p "require('./package.json').version"))"
echo

# ─── Track produced artefacts for final summary ────────────────────────────
ARTIFACTS=()
ARTIFACTS+=("sha256.txt|L1 integrity checksum")
COSIGN_OK=0
SBOM_MODE=""
GPG_SOURCE=""

# ─── Step 1: Pre-release validation ────────────────────────────────────────
step 1 "Pre-release validation (all CI gates)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: $HERE/run-all.sh"
else
  if ! "$HERE/run-all.sh"; then
    fail 1 "one or more CI gates failed"
  fi
fi
ok "CI gates pass"
echo

# ─── Step 2: Build VSIX ────────────────────────────────────────────────────
step 2 "Build VSIX (npm ci → lint → compile → package)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: npm ci && npm run lint && npm run compile && npm run package"
else
  if [ -f package-lock.json ]; then
    npm ci || fail 2 "npm ci failed"
  else
    npm install || fail 2 "npm install failed"
  fi
  npm run lint    || fail 2 "lint failed"
  npm run compile || fail 2 "compile failed"
  npm run package || fail 2 "vsce package failed"
fi
VSIX_FILE="$(ls *.vsix 2>/dev/null | head -1 || true)"
if [ -z "$VSIX_FILE" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    VSIX_FILE="ollama-cloud-provider-0.2.0.vsix (projected)"
  else
    fail 2 "no .vsix produced"
  fi
fi
ok "VSIX: $VSIX_FILE"
echo

# ─── Step 3: Compute SHA256 ────────────────────────────────────────────────
step 3 "Compute SHA256 (L1 — integrity, required)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: sha256sum '$VSIX_FILE' > sha256.txt"
else
  sha256sum "$VSIX_FILE" > sha256.txt
  SHA="$(awk '{print $1}' sha256.txt)"
  echo "  SHA256: $SHA"
fi
ok "L1 checksum written to sha256.txt"
echo

# ─── Step 4: Sigstore cosign (L2 — build provenance, optional) ─────────────
step 4 "Sigstore cosign signing (L2 — build provenance, optional)"
if command -v cosign >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  cosign installed — would sign: $VSIX_FILE, sha256.txt"
  else
    cosign sign-blob --yes "$VSIX_FILE" --output-signature "${VSIX_FILE}.sig" \
      || fail 4 "cosign sign-blob VSIX failed"
    cosign sign-blob --yes sha256.txt --output-signature "sha256.txt.sig" \
      || fail 4 "cosign sign-blob sha256.txt failed"
  fi
  COSIGN_OK=1
  ARTIFACTS+=("${VSIX_FILE}.sig|L2 sigstore — VSIX")
  ARTIFACTS+=("sha256.txt.sig|L2 sigstore — checksums")
  ok "L2 Sigstore signatures produced"
else
  warn "cosign not installed — L2 Sigstore signing skipped."
  warn "Install: https://github.com/sigstore/cosign/releases"
  echo "  (L2 is optional; L1 SHA256 + L3 GPG remain the required layers.)"
fi
echo

# ─── Step 5: GPG sign checksums (L3 — identity, required) ──────────────────
step 5 "GPG detached-sign checksums (L3 — identity, required)"

GPG_KEY_AVAILABLE=0
GPG_SOURCE=""

# Three-path strategy (Option C — most robust):
#   1. GPG_PRIVATE_KEY + GPG_PASSPHRASE env vars → import + sign with passphrase
#      (CI portability; existing Path A, already works)
#   2. GPG_PASSPHRASE only (key already in keyring) → use keyring key +
#      --pinentry-mode loopback --passphrase (local maintainer workflow)
#   3. Neither set → try keyring key + --pinentry-mode loopback with empty
#      passphrase (relies on gpg-agent cache or unprotected key).
#   4. All fail → clear error telling user how to proceed.
#
# Why --pinentry-mode loopback: without it, gpg invokes pinentry-curses
# (interactive TUI) which fails with "signal Interrupt caught" in a
# non-interactive terminal. Loopback mode lets gpg read the passphrase
# from --passphrase / --passphrase-fd instead of spawning a TUI.

GPG_LISTING="$(gpg --list-secret-keys --with-colons 2>/dev/null || true)"
KEYRING_KEY_ID="$(echo "$GPG_LISTING" | awk -F: '/^sec:/ {print $5; exit}')"

if [ -n "${GPG_PRIVATE_KEY:-}" ] && [ -n "${GPG_PASSPHRASE:-}" ]; then
  # Path 1: full env-var flow (CI portability) — import key, sign with passphrase
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would import GPG_PRIVATE_KEY from env and sign sha256.txt"
  else
    printf '%s' "$GPG_PRIVATE_KEY" | gpg --batch --import \
      || fail 5 "gpg import from env failed"
    printf '%s' "$GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 0 --sign --detach-sign --armor sha256.txt \
      || fail 5 "gpg sign (env key) failed"
  fi
  GPG_KEY_AVAILABLE=1
  GPG_SOURCE="env (GPG_PRIVATE_KEY / GPG_PASSPHRASE)"
  ok "L3 GPG signature produced via env-var key"
elif [ -n "${GPG_PASSPHRASE:-}" ] && [ -n "$KEYRING_KEY_ID" ]; then
  # Path 2: passphrase env var + keyring key — local maintainer workflow
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  found key $KEYRING_KEY_ID in keyring + GPG_PASSPHRASE set — would sign sha256.txt"
  else
    printf '%s' "$GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 0 --local-user "$KEYRING_KEY_ID" \
      --sign --detach-sign --armor sha256.txt \
      || fail 5 "gpg sign (keyring key $KEYRING_KEY_ID + GPG_PASSPHRASE) failed"
  fi
  GPG_KEY_AVAILABLE=1
  GPG_SOURCE="keyring + GPG_PASSPHRASE (key $KEYRING_KEY_ID)"
  ok "L3 GPG signature produced via keyring key $KEYRING_KEY_ID + GPG_PASSPHRASE"
elif [ -n "$KEYRING_KEY_ID" ]; then
  # Path 3: keyring key only — rely on gpg-agent cache or unprotected key.
  # Empty --passphrase is required so gpg doesn't try to spawn pinentry-curses.
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  found key $KEYRING_KEY_ID in keyring — would sign sha256.txt via gpg-agent cache"
  else
    if ! printf '' | gpg --batch --yes --pinentry-mode loopback \
        --passphrase-fd 0 --local-user "$KEYRING_KEY_ID" \
        --sign --detach-sign --armor sha256.txt 2>/tmp/gpg-sign.err; then
      err "gpg sign (keyring key $KEYRING_KEY_ID, gpg-agent cache) failed:"
      sed 's/^/    /' /tmp/gpg-sign.err >&2
      fail 5 "GPG passphrase required. Set GPG_PASSPHRASE env var, or cache the passphrase in gpg-agent (gpg --sign once interactively), or set GPG_PRIVATE_KEY + GPG_PASSPHRASE for CI flow."
    fi
  fi
  GPG_KEY_AVAILABLE=1
  GPG_SOURCE="keyring (key $KEYRING_KEY_ID, gpg-agent cache)"
  ok "L3 GPG signature produced via keyring key $KEYRING_KEY_ID (gpg-agent cache)"
fi

if [ "$GPG_KEY_AVAILABLE" -ne 1 ]; then
  fail 5 "GPG key required for L3 signing. Options: (a) set GPG_PRIVATE_KEY + GPG_PASSPHRASE env vars (CI flow); (b) import a key into the gpg keyring and set GPG_PASSPHRASE; (c) cache the passphrase in gpg-agent by signing once interactively."
fi
ARTIFACTS+=("sha256.txt.asc|L3 GPG detached signature")
echo

# ─── Step 6: SBOM ──────────────────────────────────────────────────────────
step 6 "Generate SBOM (SPDX-JSON)"
if command -v syft >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  syft installed — would run: syft . -o spdx-json=sbom.spdx.json"
  else
    syft . -o spdx-json=sbom.spdx.json || fail 6 "syft SBOM generation failed"
  fi
  SBOM_MODE="syft"
  ok "SBOM generated by syft"
else
  warn "syft not installed — generating minimal SPDX-JSON from package.json + lockfile."
  warn "Install: https://github.com/anchore/syft"
  if [ "$DRY_RUN" -ne 1 ]; then
    node --input-type=module <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
let lock = null;
try { lock = JSON.parse(readFileSync('./package-lock.json', 'utf8')); } catch {}

const pkgName = pkg.name || 'unnamed';
const pkgVersion = pkg.version || '0.0.0';
const documentId = 'spdx://ollama-cloud-provider-' + pkgVersion + '-' + Date.now();

const packages = [];
const seen = new Set();
const add = (name, version, rel) => {
  if (!name || seen.has(name)) return;
  seen.add(name);
  packages.push({ name, version: version || 'UNKNOWN', rel });
};

add(pkgName, pkgVersion, 'DESCRIBES');
for (const [n, v] of Object.entries(pkg.dependencies || {}))    add(n, v, 'DEPENDS_ON');
for (const [n, v] of Object.entries(pkg.devDependencies || {})) add(n, v, 'DEV_DEPENDS_ON');
if (lock && lock.packages) {
  for (const [p, meta] of Object.entries(lock.packages)) {
    if (!p) continue;
    const name = p.replace(/^node_modules\//, '');
    if (seen.has(name)) continue;
    add(name, meta.version || 'UNKNOWN', 'DEPENDS_ON');
  }
}

const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'MIT',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: pkgName,
  documentNamespace: documentId,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ['Tool: run-release-local.sh (fallback SBOM generator)'],
    licenseListVersion: '3.21',
  },
  packages: [{
    name: pkgName,
    SPDXID: 'SPDXRef-PACKAGE-ROOT',
    versionInfo: pkgVersion,
    downloadLocation: (pkg.repository && pkg.repository.url) || 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: pkg.license || 'NOASSERTION',
    licenseDeclared: pkg.license || 'NOASSERTION',
    copyrightText: 'NOASSERTION',
  }],
  relationships: packages
    .filter(p => p.name !== pkgName)
    .map(p => ({
      spdxElementId: 'SPDXRef-PACKAGE-ROOT',
      relationshipType: p.rel,
      relatedSpdxElement: 'SPDXRef-PACKAGE-' + p.name.replace(/[^A-Za-z0-9.-]/g, '-'),
    })),
  externalRefs: packages
    .filter(p => p.name !== pkgName)
    .map(p => ({
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: 'pkg:npm/' + p.name + '@' + p.version,
    })),
};

writeFileSync('./sbom.spdx.json', JSON.stringify(sbom, null, 2));
console.log('  fallback SBOM packages: ' + packages.length);
NODE_EOF
  fi
  SBOM_MODE="fallback (package.json + lockfile)"
  ok "SBOM generated by inline Node.js fallback"
fi
ARTIFACTS+=("sbom.spdx.json|SBOM, $SBOM_MODE")
echo "  SBOM generated: sbom.spdx.json"
echo

# ─── Step 7: Create git tag (no push) ──────────────────────────────────────
step 7 "Create annotated git tag $VERSION (no push yet)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: git tag -a '$VERSION' -m 'Release $VERSION_NUM'"
else
  if git rev-parse "$VERSION" >/dev/null 2>&1; then
    fail 7 "tag $VERSION already exists — refusing to overwrite. Bump package.json version or pick a different tag."
  fi
  git tag -a "$VERSION" -m "Release $VERSION_NUM" \
    || fail 7 "git tag creation failed"
fi
ok "Tag $VERSION ready (local only; pushed in step 10)"
echo

# ─── Step 8: Generate release notes ────────────────────────────────────────
step 8 "Generate release notes"
NOTES_FILE="/tmp/release-notes-${VERSION}.md"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would write notes to: $NOTES_FILE"
else
  PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  if [ -n "$PREV_TAG" ]; then
    LOG_RANGE="${PREV_TAG}..HEAD"
  else
    LOG_RANGE=""
  fi

  if command -v gh >/dev/null 2>&1; then
    {
      echo "# Release ${VERSION}"
      echo
      echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by run-release-local.sh"
      echo
      if [ -n "$PREV_TAG" ]; then
        echo "_Commits since ${PREV_TAG}_"
      else
        echo "_Initial release — all commits_"
      fi
      echo
      for type in feat fix chore docs refactor perf test build ci; do
        commits="$(git log ${LOG_RANGE} --oneline --no-merges --grep "^${type}(\|^${type}:" -i 2>/dev/null || true)"
        if [ -n "$commits" ]; then
          case "$type" in
            feat)     title="Features" ;;
            fix)      title="Bug Fixes" ;;
            chore)    title="Chores" ;;
            docs)     title="Documentation" ;;
            refactor) title="Refactors" ;;
            perf)     title="Performance" ;;
            test)     title="Tests" ;;
            build)    title="Build" ;;
            ci)       title="CI" ;;
          esac
          echo "## ${title}"
          echo
          echo "$commits" | sed 's/^/ - /'
          echo
        fi
      done
      echo "## Artifacts"
      echo
      echo "- \`${VSIX_FILE}\` — packaged VS Code extension"
      echo "- \`sha256.txt\` — SHA256 checksums (L1)"
      echo "- \`sha256.txt.asc\` — GPG detached signature (L3)"
      [ "$COSIGN_OK" -eq 1 ] && echo "- \`*.vsix.sig\`, \`sha256.txt.sig\` — Sigstore signatures (L2)"
      echo "- \`sbom.spdx.json\` — SBOM (${SBOM_MODE})"
    } > "$NOTES_FILE"
    ok "Release notes generated by git log (gh present, conventional-commit grouping)"
  else
    warn "gh not available — generating notes from git log --oneline only"
    {
      echo "# Release ${VERSION}"
      echo
      git log ${LOG_RANGE} --oneline --no-merges | sed 's/^/- /'
    } > "$NOTES_FILE"
    ok "Release notes generated from raw git log"
  fi
  echo "  notes file: $NOTES_FILE ($(wc -l < "$NOTES_FILE") lines)"
fi
echo

# ─── Step 9: Create GitHub Release + upload artifacts ──────────────────────
step 9 "Create GitHub Release and upload artifacts"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: gh release create '$VERSION' --title '$VERSION' --notes-file '$NOTES_FILE'"
  echo "  would upload: $VSIX_FILE, sha256.txt, sha256.txt.sig (if exists), sha256.txt.asc, ${VSIX_FILE}.sig (if exists), sbom.spdx.json"
else
  if ! command -v gh >/dev/null 2>&1; then
    fail 9 "gh CLI not installed — cannot create GitHub Release. Install: https://cli.github.com/"
  fi
  gh release create "$VERSION" \
    --title "$VERSION" \
    --notes-file "$NOTES_FILE" \
    || fail 9 "gh release create failed"

  UPLOAD_ARGS=()
  for f in "$VSIX_FILE" sha256.txt sha256.txt.sig sha256.txt.asc "${VSIX_FILE}.sig" sbom.spdx.json; do
    [ -f "$f" ] && UPLOAD_ARGS+=("$f")
  done
  if [ "${#UPLOAD_ARGS[@]}" -gt 0 ]; then
    gh release upload "$VERSION" "${UPLOAD_ARGS[@]}" --clobber \
      || fail 9 "gh release upload failed"
  fi
  ok "GitHub Release created: https://github.com/Korrnals/ollama-cloud-provider/releases/tag/${VERSION}"
fi
echo

# ─── Step 10: Push tag ─────────────────────────────────────────────────────
step 10 "Push tag $VERSION to origin"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: git push origin '$VERSION'"
else
  git push origin "$VERSION" || fail 10 "git push tag failed"
fi
ok "Tag $VERSION pushed to origin"
echo

# ─── Step 11: Move artifacts to dist/ ──────────────────────────────────────
# Release artefacts (VSIX, checksums, signatures, SBOM) are produced in the
# project root during the build/sign flow because vsce and the signing tools
# reference them by basename. After the GitHub release upload (step 9) has
# consumed them, move everything into dist/ so the project root stays clean
# and the artefacts have a single, predictable resting place.
step 11 "Move release artifacts to dist/"
DIST_DIR="$REPO_ROOT/dist"
RELEASE_ARTIFACTS=(
  "$VSIX_FILE"
  "${VSIX_FILE}.sig"
  "sha256.txt"
  "sha256.txt.sig"
  "sha256.txt.asc"
  "sbom.spdx.json"
)
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would create: $DIST_DIR"
  printf "  would move: %s\n" "${RELEASE_ARTIFACTS[@]}"
else
  mkdir -p "$DIST_DIR"
  MOVED=0
  for f in "${RELEASE_ARTIFACTS[@]}"; do
    if [ -f "$REPO_ROOT/$f" ]; then
      mv -f "$REPO_ROOT/$f" "$DIST_DIR/$f"
      MOVED=$((MOVED + 1))
    fi
  done
  echo "  moved $MOVED artefact(s) to $DIST_DIR/"
fi
ok "Artifacts staged in dist/"
echo

# ─── Summary ───────────────────────────────────────────────────────────────
echo "${C_BOLD}=== Release $VERSION summary ===${C_RESET}"
echo
printf "  %-45s %s\n" "Artefact" "Description"
printf "  %-45s %s\n" "───────────────────────────────────────────────────" "────────────────────────────"
for a in "${ARTIFACTS[@]}"; do
  name="${a%%|*}"
  desc="${a#*|}"
  printf "  %-45s %s\n" "$name" "$desc"
done
echo
printf "  %-20s %s\n" "L1 SHA256"  "✓ required — produced"
printf "  %-20s %s\n" "L2 Sigstore" "$([ "$COSIGN_OK" -eq 1 ] && echo '✓ produced' || echo '⚠ skipped (cosign not installed)')"
printf "  %-20s %s\n" "L3 GPG"     "✓ required — produced via $GPG_SOURCE"
printf "  %-20s %s\n" "SBOM"       "$SBOM_MODE"
echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "${C_YELLOW}DRY RUN completed — no mutations were performed.${C_RESET}"
else
  echo "${C_GREEN}Release $VERSION published.${C_RESET}"
fi
exit 0
