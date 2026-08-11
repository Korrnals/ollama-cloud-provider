# 0009. Endpoint Routing — Native /api/chat for Cloud, OpenAI-compat for Local

**Date:** 2026-08-03
**Status:** Accepted

## Deciders

- `@GCW: Tech Lead` (chair, engineering owner)
- `@GCW: Product Architect`
- `@GCW: Senior System Engineer`
- Owner (Korrnals) — final decision authority

## Context

The extension routed ALL cloud requests to OpenAI-compat endpoints (`/v1/chat/completions`, `/v1/responses`). docs.ollama.com/cloud prescribes the native `/api/chat` endpoint for direct cloud access. The native endpoint offers first-class `think` field (not vendor-extension), object tool_calls (not string), full-event streaming (not partial accumulation), and Ollama-specific metrics.

Spike (2026-08-03, qwen3.5:397b, curl): native `/api/chat` streaming emits `message.tool_calls[]` as a single full-event chunk with `function.arguments` as a JSON object — no partial accumulation, no `JSON.parse` needed. This is simpler than OpenAI-compat's string-fragment accumulation.

## Decision

- **Setting default → `auto`** (the `preferredEndpoint` setting defaults to `auto`). `auto` resolves at dispatch time:
  - **cloud** → `native` `/api/chat` (canonical per docs.ollama.com/cloud)
  - **local** → `chat` `/v1/chat/completions` (ecosystem, SSE, already works)
  - **vision pass-through** → `responses` `/v1/responses` (vision pass-through has no native dispatch)
- **4-way override**: `auto`/`native`/`chat`/`responses` (via `preferredEndpoint` setting)
- **Implementation**: endpoint-format-aware rewrite of `ollamaClient.ts` (not a third parallel client) — `endpointFormat: 'compat' | 'native'` parameter, `processNdjsonLine` parser
- **Phasing**: Phase 1 (opt-in native) → Phase 2 (cloud default → native) → Phase 3 (this ADR + ADR 0006 revision)
- **404 fallback**: native → compat (capability cache `nativeChatAvailable`)

## Alternatives considered

| Alternative | Verdict | Rationale |
|---|---|---|
| Third parallel client (nativeClient.ts) | rejected | ~60% code duplication, breaks unified three-timer/MidStreamError contract |
| Probe HEAD/OPTIONS for auto-detection | rejected | Extra round-trip per request, contradicts ADR 0001 (thin provider) |
| Keep responses as cloud default | rejected | Not documented as canonical by Ollama; vendor-extension for thinking; partial tool-call accumulation |
| Switch local to native too | deferred | Local works on compat (445 tests); no product benefit; separate decision |

## Consequences

- Cloud users now get native `think` field, object tool_calls, Ollama metrics by default
- `/v1/responses` and `/v1/chat/completions` remain as explicit opt-in for compatibility
- `visionFallback.ts` still uses `responses` (not migrated — separate slice)
- ADR 0006 revised: responses is no longer primary for cloud

## References

- Committee protocol: `~/.gcw/architectural-committee/2026-08-03-ollama-cloud-provider-endpoint-routing.md`
- Committee contract: `~/.gcw/architectural-committee/2026-08-03-ollama-cloud-provider-endpoint-routing-contract.md`
- Spike result (mnemos): `1c8b86f3` — native streaming tool_calls = full-event + object args
- ADR 0005 — three-timer (format-agnostic, not violated; inactivity timer disabled in v0.11.0 — see ADR 0005 revision history)
- ADR 0006 — responses primary (revised by this ADR)
- ADR 0008 — stream error handling (MidStreamError/ZeroByteSocketCloseError apply to native path)
- Ollama Cloud docs: https://docs.ollama.com/cloud
- Ollama /api/chat docs: https://docs.ollama.com/api/chat
