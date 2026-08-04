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
#   9. Push tag to origin
#  10. Create GitHub Release + upload artifacts (gh)
#
# Usage:
#   ./scripts/local-ci/run-release-local.sh             # version from package.json
#   ./scripts/local-ci/run-release-local.sh v0.2.0      # explicit version
#   ./scripts/local-ci/run-release-local.sh --dry-run   # print plan, do nothing
#
# Signing layers:
#   L1 SHA256      — always (integrity)
#   L2 Sigstore    — optional (disabled by default; set SIGSTORE_L2=1 to enable — triggers OAuth)
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
# Select VSIX by explicit version, not by glob. A glob like `ls *.vsix |
# head -1` picks the lexicographically-first VSIX — if a stale VSIX from a
# previous release (e.g. ollama-cloud-provider-0.4.0.vsix) remains in the
# root, the glob misselects it and downstream checksums/signatures are
# created for the wrong file (mnemos e7f57431).
#
# VSIX is built into releases/ (gitignored, .gitkeep tracked) so the
# project root stays clean and artefacts have a single, predictable
# resting place. SHA256/GPG/SBOM are generated alongside the VSIX in
# releases/.
RELEASES_DIR="$REPO_ROOT/releases"
mkdir -p "$RELEASES_DIR"
VSIX_FILE="$RELEASES_DIR/ollama-cloud-provider-${VERSION_NUM}.vsix"
VSIX_BASENAME="$(basename "$VSIX_FILE")"

step 2 "Build VSIX (npm ci → lint → compile → package)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: npm ci && npm run lint && npm run compile && npm run package"
  echo "  expected VSIX: $VSIX_FILE"
else
  # Defence-in-depth: remove stale VSIX from previous runs so the only VSIX
  # after packaging is the freshly-built one. The VSIX is now selected by
  # explicit filename (VSIX_FILE above), so we do NOT need to wipe releases/
  # wholesale — that would destroy the user's rollback VSIX for other versions.
  # Remove only the current-version VSIX from a prior run (defence-in-depth
  # against a stale same-version VSIX being repackaged). Do NOT wipe other
  # versions — releases/ holds rollback VSIX for the user.
  rm -f "$VSIX_FILE" "$RELEASES_DIR/ollama-cloud-provider-${VERSION_NUM}.vsix"
  # Also clean any stray VSIX in the project root (vsce's default output location
  # if -o is ever omitted) — but ONLY the root, not releases/.
  rm -f *.vsix
  if [ -f package-lock.json ]; then
    npm ci || fail 2 "npm ci failed"
  else
    npm install || fail 2 "npm install failed"
  fi
  npm run lint    || fail 2 "lint failed"
  npm run compile || fail 2 "compile failed"
  # vsce package -o writes to the explicit path; no globbing ambiguity.
  npx vsce package -o "$VSIX_FILE" || fail 2 "vsce package failed"
  if [[ ! -f "$VSIX_FILE" ]]; then
    err "expected VSIX $VSIX_FILE not found"
    ls -la releases/*.vsix 2>/dev/null || echo "(no .vsix files in releases/)"
    fail 2 "expected VSIX $VSIX_FILE not produced"
  fi
fi
ok "VSIX: $VSIX_FILE"
echo

# ─── Step 3: Compute SHA256 ────────────────────────────────────────────────
step 3 "Compute SHA256 (L1 — integrity, required)"
SHA256_FILE="$RELEASES_DIR/sha256.txt"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: sha256sum '$VSIX_FILE' > '$SHA256_FILE'"
  echo "  would assert: $SHA256_FILE references $VSIX_BASENAME"
else
  sha256sum "$VSIX_FILE" > "$SHA256_FILE"
  SHA="$(awk '{print $1}' "$SHA256_FILE")"
  echo "  SHA256: $SHA"
  # Assert sha256.txt references the expected VSIX (not a stale one).
  # sha256sum writes the basename, so the assert checks basename match.
  if ! grep -q "$VSIX_BASENAME" "$SHA256_FILE"; then
    err "$SHA256_FILE does not reference $VSIX_BASENAME — aborting"
    cat "$SHA256_FILE" >&2
    fail 3 "checksum references wrong VSIX — stale misselection detected"
  fi
fi
ok "L1 checksum written to $SHA256_FILE (verified: references $VSIX_BASENAME)"
echo

# ─── → Step 4: Sigstore cosign signing (L2 — build provenance, optional)

if [[ "${SIGSTORE_L2:-0}" != "1" ]]; then
  warn "L2 Sigstore signing disabled (set SIGSTORE_L2=1 to enable). Triggers OAuth browser flow by default — opt-in only."
else
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  cosign installed — would sign: $VSIX_FILE, $SHA256_FILE"
      COSIGN_OK=1
      ARTIFACTS+=("${VSIX_BASENAME}.sigstore.bundle|L2 sigstore bundle — VSIX")
      ARTIFACTS+=("sha256.txt.sigstore.bundle|L2 sigstore bundle — checksums")
      ok "L2 Sigstore signatures would be produced"
    else
      # L2 is optional per script contract — degrade on any cosign failure
      # (deprecated flag, auth error, network, keyless unavailability) rather
      # than aborting the whole release. Uses --bundle (new format); the
      # legacy --output-signature flag is deprecated and fails on recent
      # cosign with "must specify --bundle with --new-bundle-format".
      VSIX_BUNDLE="${VSIX_FILE}.sigstore.bundle"
      SHA_BUNDLE="${SHA256_FILE}.sigstore.bundle"
      if cosign sign-blob --yes "$VSIX_FILE" --bundle "$VSIX_BUNDLE" 2>/tmp/cosign-vsix.err; then
        COSIGN_OK=1
        ARTIFACTS+=("${VSIX_BASENAME}.sigstore.bundle|L2 sigstore bundle — VSIX")
        ok "L2 Sigstore VSIX bundle produced: $VSIX_BUNDLE"
      else
        warn "cosign sign-blob VSIX failed (L2 optional, continuing): $(tr -d '\n' < /tmp/cosign-vsix.err)"
      fi
      if cosign sign-blob --yes "$SHA256_FILE" --bundle "$SHA_BUNDLE" 2>/tmp/cosign-sha.err; then
        ARTIFACTS+=("sha256.txt.sigstore.bundle|L2 sigstore bundle — checksums")
        ok "L2 Sigstore checksum bundle produced: $SHA_BUNDLE"
      else
        warn "cosign sign-blob sha256.txt failed (L2 optional, continuing): $(tr -d '\n' < /tmp/cosign-sha.err)"
      fi
      rm -f /tmp/cosign-vsix.err /tmp/cosign-sha.err
    fi
  else
    warn "cosign not installed — L2 Sigstore signing skipped."
    warn "Install: https://github.com/sigstore/cosign/releases"
    echo "  (L2 is optional; L1 SHA256 + L3 GPG remain the required layers.)"
  fi
  echo

  # ─── 
fi

Step 5: GPG sign checksums (L3 — identity, required) ──────────────────
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

# Decode GPG_PASSPHRASE if it is base64-encoded. The user may store the
# passphrase base64-encoded in ~/.bashrc to avoid accidental shoulder-surf
# leakage. gpg needs the decoded plaintext value, so we transparently decode
# here. Safety: NEVER print the passphrase value (neither base64 nor
# decoded) — only a one-word hint for debugging.
GPG_PASSPHRASE_ENCODING="unset"
if [ -n "${GPG_PASSPHRASE:-}" ]; then
  DECODED_PASSPHRASE=""
  if DECODED_PASSPHRASE=$(printf '%s' "$GPG_PASSPHRASE" | base64 -d 2>/dev/null) \
      && [ -n "$DECODED_PASSPHRASE" ] \
      && [ "$DECODED_PASSPHRASE" != "$GPG_PASSPHRASE" ] \
      && ! printf '%s' "$DECODED_PASSPHRASE" | LC_ALL=C grep -q '[^[:print:][:space:]]'; then
    # base64 decode succeeded, produced a different value, and the result
    # is printable ASCII (not arbitrary binary). Use the decoded value.
    GPG_PASSPHRASE="$DECODED_PASSPHRASE"
    GPG_PASSPHRASE_ENCODING="base64 (decoded)"
  else
    GPG_PASSPHRASE_ENCODING="plaintext"
  fi
fi

if [ -n "${GPG_PRIVATE_KEY:-}" ] && [ -n "${GPG_PASSPHRASE:-}" ]; then
  # Path 1: full env-var flow (CI portability) — import key, sign with passphrase
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would import GPG_PRIVATE_KEY from env and sign $SHA256_FILE"
    echo "  GPG_PASSPHRASE: $GPG_PASSPHRASE_ENCODING"
  else
    printf '%s' "$GPG_PRIVATE_KEY" | gpg --batch --import \
      || fail 5 "gpg import from env failed"
    printf '%s' "$GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 0 --sign --detach-sign --armor "$SHA256_FILE" \
      || fail 5 "gpg sign (env key) failed"
  fi
  GPG_KEY_AVAILABLE=1
  GPG_SOURCE="env (GPG_PRIVATE_KEY / GPG_PASSPHRASE)"
  ok "L3 GPG signature produced via env-var key"
elif [ -n "${GPG_PASSPHRASE:-}" ] && [ -n "$KEYRING_KEY_ID" ]; then
  # Path 2: passphrase env var + keyring key — local maintainer workflow
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  found key $KEYRING_KEY_ID in keyring + GPG_PASSPHRASE set — would sign $SHA256_FILE"
    echo "  GPG_PASSPHRASE: $GPG_PASSPHRASE_ENCODING"
  else
    printf '%s' "$GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 0 --local-user "$KEYRING_KEY_ID" \
      --sign --detach-sign --armor "$SHA256_FILE" \
      || fail 5 "gpg sign (keyring key $KEYRING_KEY_ID + GPG_PASSPHRASE) failed"
  fi
  GPG_KEY_AVAILABLE=1
  GPG_SOURCE="keyring + GPG_PASSPHRASE (key $KEYRING_KEY_ID)"
  ok "L3 GPG signature produced via keyring key $KEYRING_KEY_ID + GPG_PASSPHRASE"
elif [ -n "$KEYRING_KEY_ID" ]; then
  # Path 3: keyring key only — rely on gpg-agent cache or unprotected key.
  # Empty --passphrase is required so gpg doesn't try to spawn pinentry-curses.
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  found key $KEYRING_KEY_ID in keyring — would sign $SHA256_FILE via gpg-agent cache"
  else
    if ! printf '' | gpg --batch --yes --pinentry-mode loopback \
        --passphrase-fd 0 --local-user "$KEYRING_KEY_ID" \
        --sign --detach-sign --armor "$SHA256_FILE" 2>/tmp/gpg-sign.err; then
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
SBOM_FILE="$RELEASES_DIR/sbom.spdx.json"
if command -v syft >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  syft installed — would run: syft . -o spdx-json=$SBOM_FILE"
  else
    syft . -o spdx-json="$SBOM_FILE" || fail 6 "syft SBOM generation failed"
  fi
  SBOM_MODE="syft"
  ok "SBOM generated by syft"
else
  warn "syft not installed — generating minimal SPDX-JSON from package.json + lockfile."
  warn "Install: https://github.com/anchore/syft"
  if [ "$DRY_RUN" -ne 1 ]; then
    SBOM_OUTPUT="$SBOM_FILE" node --input-type=module <<'NODE_EOF'
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

writeFileSync(process.env.SBOM_OUTPUT, JSON.stringify(sbom, null, 2));
console.log('  fallback SBOM packages: ' + packages.length);
NODE_EOF
  fi
  SBOM_MODE="fallback (package.json + lockfile)"
  ok "SBOM generated by inline Node.js fallback"
fi
ARTIFACTS+=("sbom.spdx.json|SBOM, $SBOM_MODE")
echo "  SBOM generated: $SBOM_FILE"
echo

# ─── Step 7: Create git tag (no push) ──────────────────────────────────────
step 7 "Create annotated git tag $VERSION (no push yet)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: git tag -a '$VERSION' -m 'Release $VERSION_NUM'"
else
  if git rev-parse "$VERSION" >/dev/null 2>&1; then
    warn "tag $VERSION already exists — skipping tag creation (release will use existing tag)"
  else
    git tag -a "$VERSION" -m "Release $VERSION_NUM" \
      || fail 7 "git tag creation failed"
    ok "Annotated git tag $VERSION created"
  fi
fi
ok "Tag $VERSION ready (local only; pushed in step 9)"
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
      echo "- \`${VSIX_BASENAME}\` — packaged VS Code extension"
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

# ─── Step 9: Push tag ─────────────────────────────────────────────────────
step 9 "Push tag $VERSION to origin"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: git push origin '$VERSION'"
else
  git push origin "$VERSION" || fail 9 "git push tag failed"
fi
ok "Tag $VERSION pushed to origin"
echo

# ─── Step 10: Create GitHub Release + upload artifacts ─────────────────────
step 10 "Create GitHub Release and upload artifacts"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would run: gh release create '$VERSION' --title '$VERSION' --notes-file '$NOTES_FILE'"
    echo "  would upload: $VSIX_FILE, $SHA256_FILE, ${SHA256_FILE}.asc, ${VSIX_FILE}.sigstore.bundle, ${SHA256_FILE}.sigstore.bundle, $SBOM_FILE"
else
  if ! command -v gh >/dev/null 2>&1; then
    fail 10 "gh CLI not installed — cannot create GitHub Release. Install: https://cli.github.com/"
  fi
  # Idempotent: if the release already exists, upload to it; else create it.
  if gh release view "$VERSION" >/dev/null 2>&1; then
    warn "GitHub Release $VERSION already exists — uploading artifacts to existing release"
  else
    gh release create "$VERSION" \
      --title "$VERSION" \
      --notes-file "$NOTES_FILE" \
      || fail 10 "gh release create failed"
    ok "GitHub Release created: https://github.com/Korrnals/ollama-cloud-provider/releases/tag/${VERSION}"
  fi

  # Upload from releases/ — all artefacts are already staged there.
  # --clobber overwrites existing assets if the release pre-existed.
  UPLOAD_ARGS=()
  for f in "$VSIX_FILE" "$SHA256_FILE" "${SHA256_FILE}.asc" "${VSIX_FILE}.sigstore.bundle" "${SHA256_FILE}.sigstore.bundle" "$SBOM_FILE"; do
    [ -f "$f" ] && UPLOAD_ARGS+=("$f")
  done
  if [ "${#UPLOAD_ARGS[@]}" -gt 0 ]; then
    gh release upload "$VERSION" "${UPLOAD_ARGS[@]}" --clobber \
      || fail 10 "gh release upload failed"
    ok "Artifacts uploaded to GitHub Release $VERSION (${#UPLOAD_ARGS[@]} files)"
  fi
fi
echo

# ─── Step 11: Confirm artifacts in releases/ ───────────────────────────────
# All release artefacts (VSIX, checksums, signatures, SBOM) are produced
# directly in releases/ during the build/sign flow (steps 2-6). No post-hoc
# move is needed — releases/ is the single resting place. This step simply
# reports the final state for the operator.
step 11 "Confirm release artifacts in releases/"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  would list: $RELEASES_DIR"
else
  echo "  artefacts in $RELEASES_DIR:"
  ls -1 "$RELEASES_DIR" 2>/dev/null | sed 's/^/    /' || echo "    (empty)"
fi
ok "Artifacts staged in releases/"
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
