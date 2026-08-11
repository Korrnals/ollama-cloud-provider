# ADR-0002: Signing strategy

**Date:** 2026-07-16
**Status:** Accepted

## Context

Unsigned VSIX distribution cannot be verified by users. Without signing, CI, or checksums:

- Users cannot verify the VSIX they installed was built from the reviewed source.
- A compromised publisher account could ship a malicious auto-update.
- There is no provenance attestation (which commit, which CI run built the VSIX).

## Decision

Adopt a three-layer signing strategy (all free, all open-source):

### Layer 1 — Integrity: SHA256 checksums

CI computes `sha256sum` of the built VSIX and publishes it in the GitHub Release. Users verify with `sha256sum -c sha256.txt`.

**What it proves:** The VSIX file has not been modified since release.

### Layer 2 — Release provenance: cosign signing (keypair mode since v0.9.0; keyless before)

CI signs the VSIX (and checksums) with [Sigstore](https://www.sigstore.dev/) `cosign sign-blob --yes`, using GitHub OIDC as the identity. No long-lived signing key — the signing certificate is ephemeral, issued per-CI-run, bound to the GitHub repository and commit.

Users verify with:
```bash
cosign verify-blob \
  --certificate-identity-regexp 'https://github\.com/Korrnals/ollama-cloud-provider/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --signature ollama-cloud-provider-*.vsix.sig \
  ollama-cloud-provider-*.vsix
```

**What it proves:** This VSIX was built in GitHub Actions, in this repository, from a specific commit. The build is reproducible and attributable.

### Layer 3 — Identity: GPG signature

The release checksums file is additionally signed with the maintainer's GPG key. The public key is published in the repository (`gpg-public-key.asc`) and on a keyserver.

Users verify with:
```bash
gpg --verify sha256.txt.sig sha256.txt
```

**What it proves:** The release was authored by the maintainer, not just built by CI. This protects against a compromised CI secret that doesn't also have the GPG key.

## Note (2026-07-22) — local signing fallback

GitHub Actions release workflow is disabled due to billing lock (see `.github/workflows/release.yml`). Signing is performed locally via `scripts/local-ci/run-release-local.sh` until billing is resolved.

The three-layer signing strategy (SHA256 + Sigstore keyless + GPG) is **unchanged** — only the execution environment moved from GitHub Actions to local. The Sigstore keyless identity in local mode is the maintainer's OIDC identity (not the GitHub Actions run identity); the verification command in Layer 2 must be adjusted to match the local signing identity when verifying locally-built VSIX artifacts.

## Revision — 2026-08-04 (v0.9.0): keyless → keypair

Layer 2 switched from opt-in **keyless** mode (interactive OAuth, ephemeral
per-run certificate bound to GitHub OIDC) to always-on **keypair** mode
(`cosign.key` / `cosign.pub`, no browser flow). Rationale: keyless mode
triggered an OAuth browser flow that broke local releases; keypair mode
runs unattended. `cosign.pub` (the public verification key) is committed to
the repo root so consumers can verify `.sigstore.bundle` artefacts without
an out-of-band channel; `cosign.key` stays gitignored.

The verification command for v0.9.0+ releases uses the key, not the
keyless certificate chain:

```bash
cosign verify-blob \
  --bundle releases/*.sigstore.bundle \
  --key cosign.pub \
  ollama-cloud-provider-*.vsix
```

The original keyless verification command in Layer 2 below is preserved as
the historical record; it applies only to pre-v0.9.0 releases. The "No
long-lived signing keys in CI" positive consequence is amended: there is
now one long-lived signing keypair (`cosign.key`), protected by gitignore
+ maintainer-only access; the GPG key remains the identity layer.

## Rejected alternatives

- **L4: Paid code-signing certificate (Authenticode)** — VS Code does not use Authenticode verification for extension trust. The cost ($200-400/year) buys a marketing badge, not a security guarantee VS Code enforces. Overkill for a community extension.

## Consequences

- **Positive:** Three independent verification layers — integrity, provenance, identity. All free. Users can verify at whichever layer they trust.
- **Positive:** No long-lived signing keys in CI (Sigstore is keyless). GPG key is stored as a GitHub secret, used only in release workflow.
- **Negative:** Users must install `cosign` and `gpg` to verify at L2/L3. L1 (SHA256) requires only coreutils.
- **Neutral:** The GPG public key must be distributed out-of-band (keyserver, README) for full trust; in-repo distribution alone is circular.
