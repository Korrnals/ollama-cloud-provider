# Development Plan — ollama-cloud-provider v0.2.0

**Project:** Security-hardened fork of zelosleone/Ollama-Cloud-for-Copilot
**Owner:** Korrnals
**Repo:** https://github.com/Korrnals/ollama-cloud-provider
**Local:** /var/home/abyss/.distrobox/vscode-box/home/LABs/Projects/ollama-cloud-provider

## Architecture

```
src/
  extension.ts          — activation, command registration, provider wiring
  provider.ts           — LanguageModelChatProvider implementation (from upstream, hardened)
  auth.ts               — API key management via SecretStorage (from upstream, verified)
  ollamaClient.ts       — HTTP client, SSE streaming (from upstream, hardened)
  logger.ts             — Output channel logger WITH REDACTION (hardened)
  modelCatalog.ts       — Model list management (from upstream)
  modelConfiguration.ts — Per-model config schema (from upstream, extended)
  convert.ts            — VS Code ↔ OpenAI message/tool conversion (from upstream)
  protocolTypes.ts      — TypeScript types (from upstream)
  configValidator.ts    — NEW: validate config (baseUrl in whitelist, key present)
  healthCheck.ts         — NEW: check connection to Ollama Cloud
  retry.ts              — NEW: exponential backoff retry wrapper
test/
  runTest.ts            — test runner
  suite/                — test suites
```

## Issues backlog (execution order)

### Phase 1 — Foundation (no code changes)

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 1 | Create GitHub remote repo `Korrnals/ollama-cloud-provider` (public) | infra | Korrnals | 5m |
| 2 | Generate GPG signing key, add as GitHub secret `GPG_PRIVATE_KEY` + `GPG_PASSPHRASE` | infra | Korrnals | 15m |
| 3 | Configure branch protection on `main`: require PR, require CI, no force-push | infra | Korrnals | 5m |
| 4 | First commit: scaffold + initial push to main | chore | Tech Lead | 10m |

### Phase 2 — Port upstream source

| # | Issue | Type | Assignee | Est |
|---|---|---|---|---|
| 5 | Port source files from upstream v0.1.9 to `src/` | feat | Senior System Engineer | 1h |
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
