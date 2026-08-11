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
2. **Cosign keypair signing** — release provenance (which maintainer, which key signed this VSIX). Switched from opt-in keyless mode to always-on keypair mode in v0.9.0 (`cosign.key` / `cosign.pub`, no browser flow).
3. **GPG signature** — identity (the release was signed by the maintainer's GPG key).

See [ADR-0002](docs/adr/0002-signing-strategy.md) for the full rationale.

### Public verification key (`cosign.pub`)

The repo root ships `cosign.pub` — the **public** half of the signing
keypair (keypair mode since v0.9.0; not keyless). It is committed (not gitignored) so downstream
consumers can verify `.sigstore.bundle` artifacts without an
out-of-band channel:

```bash
cosign verify-blob --certificate-identity <identity> \
  --certificate-oidc-issuer <issuer> \
  --bundle releases/*.sigstore.bundle <VSIX> \
  --key cosign.pub
```

The private key (`cosign.key`) stays gitignored (via `*.key`) and never
leaves the maintainer's machine. `cosign.pub` is safe to redistribute —
it can only verify signatures, not create them.

> **Note (2026-07-22):** GitHub Actions release workflow is disabled due to billing lock. Signing is performed locally via `scripts/local-ci/run-release-local.sh` until billing is resolved. The three-layer strategy is unchanged; only the execution environment moved from GitHub Actions to local.
