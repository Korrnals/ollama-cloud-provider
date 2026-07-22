# Development Plan — ollama-cloud-provider

**Project:** Security-hardened Ollama Cloud language model provider for VS Code Copilot Chat
**Owner:** Korrnals
**Repo:** https://github.com/Korrnals/ollama-cloud-provider
**Local:** /var/home/abyss/.distrobox/vscode-box/home/LABs/Projects/ollama-cloud-provider

## Completed milestones

| Version | Date | Theme | Highlights |
|---|---|---|---|
| v0.2.0 | 2026-07-16 | Port + security hardening | Fork from `sidharth-sachdeva/ollama-vscode-extension`; trimmed to provider-only; logger redaction; `allowedBaseUrls` whitelist; `scope: application` on all config; no `child_process`/`eval`/`webview`/`telemetry`. |
| v0.2.1 | 2026-07-17 | Error redaction | `safeJsonParse` surfaces malformed responses; error-path redaction hardened. |
| v0.3.0 | 2026-07-19 | Test scaffold + 75 tests | Unit, integration, e2e, race-condition suites; 9 local CI gates wired; `run-release-local.sh` for signed local releases. |
| v0.4.0 | 2026-07-20 | Vision + multi-connection + fork-attribution cleanup | Per-model vision capability inference; `ConnectionConfig` multi-connection (Cloud/Local/VPS/custom) with per-connection `allowedBaseUrls` + key isolation; fork attribution cleaned up in source comments and README. |
| v0.5.0 | 2026-07-22 | Vision Fallback Pass-through + base64 redaction + CancellationToken race fix | ADR 0004 single-hop vision fallback (opt-in, pass-through); `redactSensitive` masks `data:image/*;base64,...`; synchronous `isCancellationRequested` check before first await in `ollamaClient.streamChat`; 305 tests passing. |

## CI and release

External GitHub Actions CI is **disabled** (billing lock, 2026-07-22). All CI runs locally via `scripts/local-ci/run-all.sh`. Releases are cut locally via `scripts/local-ci/run-release-local.sh` (produces signed VSIX + SBOM + Sigstore + GPG). Re-enable GitHub Actions (`.github/workflows/ci.yml` and `release.yml`) when billing is resolved — uncomment the `on:` block and remove the `on: []` line in each file.

The 9 local CI gates are unchanged: `compile`, `lint`, `no-rce-primitives`, `no-telemetry`, `no-webview-uri`, `npm-audit`, `scope-application`, `secrets-scan`, `test`.

## Architecture

```
src/
  extension.ts                 — activation, command registration, provider wiring
  provider.ts                  — LanguageModelChatProvider implementation (vision gate, fallback hook)
  auth.ts                      — API key management via SecretStorage
  ollamaClient.ts              — HTTP client, SSE streaming (CancellationToken race-fixed)
  logger.ts                    — Output channel logger WITH REDACTION (Bearer, api_key, base64 image)
  modelCatalog.ts              — Model list management + vision-capability inference
  modelConfiguration.ts        — Per-model config schema
  convert.ts                   — VS Code ↔ OpenAI message/tool conversion
  protocolTypes.ts             — TypeScript types
  configValidator.ts           — validate config (baseUrl in whitelist, key present)
  healthCheck.ts               — check connection to Ollama Cloud
  retry.ts                     — exponential backoff retry wrapper
  connections.ts               — Multi-connection list (ConnectionConfig: per-connection baseUrl + key isolation)
  visionFallback.ts            — Vision Fallback Pass-through core (ADR 0004: single-hop routing)
  visionFallbackCommands.ts    — QuickPick commands: Set Vision Fallback Model / Connection
test/
  unit/ integration/ e2e/ race/ — test suites (305 tests)
```

## Issues backlog (execution order)

### Phase 1 — Foundation (no code changes)

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 1 | Create GitHub remote repo `Korrnals/ollama-cloud-provider` (public) | infra | Korrnals | 5m |
| 2 | Generate GPG signing key, add as GitHub secret `GPG_PRIVATE_KEY` + `GPG_PASSPHRASE` | infra | Korrnals | 15m |
| 3 | Configure branch protection on `main`: require PR, require CI, no force-push | infra | Korrnals | 5m |
| 4 | First commit: scaffold + initial push to main | chore | Tech Lead | 10m |

### Phase 2 — Source implementation

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 5 | Implement source files in `src/` per architecture above | feat | Senior System Engineer | 1h |
| 6 | Add `npm ci` + verify compile passes | chore | Senior System Engineer | 15m |
| 7 | Verify extension loads in Extension Development Host | test | Senior System Engineer | 30m |

### Phase 3 — Security hardening

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 8 | Harden `logger.ts`: redact Bearer tokens and api_key patterns before JSON.stringify | fix(sec) | Senior System Engineer | 30m |
| 9 | Add `allowedBaseUrls` whitelist: refuse requests to non-whitelisted baseUrl | fix(sec) | Senior System Engineer | 1h |
| 10 | Harden `safeJsonParse`: surface malformed responses instead of silent swallow | fix(sec) | Senior System Engineer | 30m |
| 11 | CI security gate: verify all `ollamaCloud.*` config has `scope: "application"` | ci | SRE/DevOps | 30m |
| 12 | CI security gate: grep for `child_process`/`eval`/`Function`/`webview`/`uriHandler` | ci | SRE/DevOps | 30m |

### Phase 4 — Reliability & UX

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 13 | Add `retry.ts`: exponential backoff for 429/5xx responses | feat | Senior System Engineer | 1h |
| 14 | Add `requestTimeoutMs` config + wire to fetch AbortController timeout | feat | Senior System Engineer | 30m |
| 15 | Add `healthCheck.ts`: `Ollama Cloud: Check Connection` command | feat | Senior System Engineer | 45m |
| 16 | Add `configValidator.ts`: `Ollama Cloud: Validate Configuration` command | feat | Senior System Engineer | 45m |
| 17 | Smart notification: when model selected without key, show "Set API Key" prompt | feat | Senior System Engineer | 30m |

### Phase 5 — Release

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 18 | Verify CI pipeline passes on PR | ci | SRE/DevOps | 30m |
| 19 | Security review of hardened code | review | Senior Security Engineer | 1h |
| 20 | Tag `v0.2.0`, trigger release workflow, verify signed VSIX | release | SRE/DevOps | 45m |
| 21 | Verify release artifacts: VSIX + SHA256 + .sig + .asc + SBOM | verify | SRE/DevOps | 30m |

## Git workflow

- Trunk-based: `main` is protected, PR required.
- Branch naming: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`, `release/<slug>`.
- Conventional commits: `feat(provider): ...`, `fix(logger): ...`, `docs(adr): ...`.
- Versioning: SemVer 2.0.0. During 0.x.x, breaking bumps MINOR.
- Release: tag `v0.2.0` → release workflow builds + signs + publishes GitHub Release.

## Definition of done (v0.2.0)

- [ ] All issues 1-21 closed
- [ ] CI green on main
- [ ] Security review passed
- [ ] Release v0.2.0 published with: VSIX, sha256.txt, sha256.txt.sig, sha256.txt.asc, *.vsix.sig, sbom.spdx.json
- [ ] Manual verification: install VSIX, set key, use model in Copilot Chat, verify no secrets in logs
