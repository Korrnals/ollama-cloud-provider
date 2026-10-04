# Security Policy

## Supported versions

Only the latest release is supported with security updates.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately:

1. Go to [github.com/Korrnals/ollama-cloud-provider/security/advisories/new](https://github.com/Korrnals/ollama-cloud-provider/security/advisories/new).
2. Use GitHub's private vulnerability reporting.
3. Include: description, steps to reproduce, impact, suggested fix (if any).

You will receive a response within 72 hours. If confirmed, a fix and CVE (if applicable) will be issued.

## Threat model

This extension handles an Ollama Cloud API key and forwards prompts/responses to the Ollama Cloud API. The threat model assumes:

- The workspace may contain untrusted files (cloned repos).
- The network may be hostile (MITM, DNS spoofing).
- The Marketplace VSIX may differ from the reviewed source.

### Mitigations

| Threat | Mitigation |
|---|---|
| API key exfiltration via workspace settings | `scope: "application"` — workspace cannot override |
| API key sent to untrusted host | `allowedBaseUrls` whitelist — extension refuses non-whitelisted hosts |
| API key in logs | Logger redaction — `Bearer`/`api_key` masked before `JSON.stringify` |
| Malformed response exploitation | `safeJsonParse` surfaces errors, does not silently swallow |
| Supply chain compromise | CI-built VSIX + cosign keypair signing + GPG + SHA256 + SBOM |
| Auto-update risk | Documented install-from-release path with checksum verification |

### What this extension does NOT do

- No `child_process` — no command execution.
- No webview — no model-controlled HTML rendering.
- No URI handler — no webpage-triggered actions.
- No context-file ingestion — no prompt injection from workspace files.
- No autocomplete — no proactive file content sending.
- No telemetry — no phone-home, no analytics, no usage reporting.

## Signing

Every release VSIX is signed with:

1. **SHA256 checksum** — integrity verification.
2. **Cosign keypair signing** — release provenance (which environment, which key signed this VSIX). Switched from opt-in keyless mode to always-on keypair mode in v0.9.0 (public keys at the repo root — see the table below; no browser flow).
3. **GPG signature** — identity (the release was signed by the maintainer's GPG key).

See [ADR-0002](docs/adr/0002-signing-strategy.md) for the full rationale.

### Cosign verification (two active keys + one legacy)

The cosign axis is signed by whatever environment cut the release, so the
repo root ships **all three** public keys. Each release's signature
artifact (`.vsix.sig`, or `.sigstore.bundle` for v0.13.0 and earlier)
names its signer via the bundle's `publicKey.hint` — base64(SHA-256) of
the key's DER form — so the correct key is always identifiable from the
artifact itself:

| Key file | `publicKey.hint` | Signed releases | Signing environment |
|---|---|---|---|
| `cosign-conveyor.pub` | `CMpOoASud/Gg2ANVs5q5db9cntn+kd65Pa9EPCWGHVk=` | v0.21.0, v0.22.0, v0.22.2 (current) | cluster release conveyor |
| `cosign-local.pub` | `TToF0M4vRvBakJO0myP0pngQF9WHHKwLSvZiOaCZu8c=` | v0.14.0–v0.20.1, v0.22.1 | local pipeline (`scripts/local-ci/run-release-local.sh`) |
| `cosign-legacy.pub` | `umycv3Zx08cxI9X6nPDoWl83jU5eQlaGaRhgnnuj8lo=` | v0.9.0–v0.13.0 | local, keypair mode (pre-conveyor) |
| — (keyless) | certificate in the bundle | v0.7.3–v0.8.0 | local, Sigstore keyless (see ADR-0002) |

Verify a downloaded release asset against the matching key:

```bash
# conveyor-signed (v0.21.0, v0.22.0, v0.22.2):
cosign verify-blob --key cosign-conveyor.pub \
  --bundle ollama-cloud-provider-0.22.2.vsix.sig ollama-cloud-provider-0.22.2.vsix

# local-pipeline-signed (v0.14.0–v0.20.1, v0.22.1):
cosign verify-blob --key cosign-local.pub \
  --bundle ollama-cloud-provider-0.22.1.vsix.sig ollama-cloud-provider-0.22.1.vsix
```

Conveyor-signed bundles embed Rekor transparency-log entries; for offline
verification add `--insecure-ignore-tlog` (the keypair signature check is
unaffected).

> **History note (2026-10-04):** until this change the repo shipped a
> single `cosign.pub` — now renamed `cosign-legacy.pub`, content
> unchanged — that matched none of the keys actually signing recent
> releases, so the cosign layer of v0.14.0–v0.22.2 could not be verified
> from the repo. Both actual signing keys are now published, and every
> published signed asset from v0.9.0 through v0.22.2 has been verified
> against the key its bundle names.

The private halves never enter the repo: the conveyor key lives in a
cluster secret (only its public part was extracted for this publication),
the local-pipeline key in the maintainer's out-of-repo signing directory;
the legacy `cosign.key` stays gitignored (via `*.key`). All `.pub` files
are safe to redistribute — they can only verify signatures, not create
them.

### GPG verification (`gpg-public-key.asc`)

The repo root also ships `gpg-public-key.asc` — the public release-signing
keyblock for the GPG detached signatures (`.asc` assets) on releases. The
key was rotated 2026-09-30 (two generations after the original F49BE957
key); the committed file is the current key, and it verifies `.asc`
signatures on releases since v0.21.0. Pre-rotation releases (v0.18.0–
v0.20.1) were signed by an intermediate key that was never published in
this repo — their `.asc` layers cannot be verified today; rely on the
cosign signature and SHA-256 checksums for those releases.

```bash
gpg --import gpg-public-key.asc
gpg --verify ollama-cloud-provider-*.vsix.asc ollama-cloud-provider-*.vsix
```

> **Note (2026-07-22):** GitHub Actions release workflow is disabled due to billing lock. Signing is performed locally via `scripts/local-ci/run-release-local.sh` until billing is resolved. The three-layer strategy is unchanged; only the execution environment moved from GitHub Actions to local.
