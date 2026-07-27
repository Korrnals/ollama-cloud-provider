# 0005. Streaming Timeout Architecture — connect / inactivity / max-duration

**Date:** 2026-07-27
**Status:** Accepted

## Deciders

- `@GCW: Tech Lead` (chair, engineering owner)
- `@GCW: Product Architect`
- `@GCW: Senior System Engineer`
- `@GCW: Senior QA Engineer`
- Owner (Korrnals) — final decision authority

## Context

The extension is a security-hardened `LanguageModelChatProvider` for Ollama Cloud (ADR 0001). `streamChat` in `ollamaClient.ts` performs POST `/chat/completions` with SSE streaming. v0.4.0 (Issue 14) introduced a single end-to-end 120 s timeout wrapping the whole stream — if no `[DONE]` arrived within 120 s of the `fetch` call, the request aborted with `timed out after 120000ms`.

After v0.5.0 (vision-fallback routing to `minimax-m3`, 262K context — ADR 0004), the collision frequency grew. Reasoning models legitimately produce output for minutes; the single 120 s timer killed legitimate long reasoning streams. The user saw `timed out after 120000ms` on streams that were alive and producing `delta.reasoning` chunks.

The owner rejected two reflexive fixes:

- «Just raise to 10 minutes» — бездумное поднятие. The end-to-end timer does not reset on chunk arrival, so a raised timer still kills very long reasoning and does not distinguish a dead connection from a slow one.
- «Just remove the timeout» — тупо убрать, антипаттерн. No timeout means a forgotten tab or a crashed caller bills tokens to a dead session indefinitely.

The committee convened to decide an architecture that distinguishes a dead connection from a live slow reasoning stream, does not kill legitimate long reasoning, and protects the user's token budget from forgotten tabs.

Two spikes were conducted before the committee to replace hypotheses with facts (see "Spike results").

## Decision

Replace the single end-to-end 120 s timeout with three timers, each with a distinct purpose:

1. **Connect timeout (30 s, with retry).** Bounds the initial `fetch` + status check. Retried via the existing `withRetry` wrapper (`retry.ts`) — the wrapper is already correct for the connect phase per `retry.ts:11-17` («do NOT wrap SSE streaming in retry; only wrap the initial connection»). Covers «server unreachable». Default 30 s, user-tunable `ollamaCloud.requestConnectTimeoutMs` (clamp 1 s–120 s).

2. **Inactivity timeout (90 s, reset on each chunk, no retry).** Starts when the first byte of the response body arrives. Reset on every chunk boundary and every `: keep-alive` SSE comment. If no chunk arrives for 90 s → abort with `abortReason='timeout'` → `onError`. This is the «is the model still reasoning or is the connection dead?» check. No mid-stream retry — POST `/chat/completions` is not idempotent. Default 90 s, user-tunable `ollamaCloud.requestInactivityTimeoutMs` (clamp 10 s–600 s).

3. **Max-duration safety cap (30 min, not reset, no retry).** Hard ceiling from the moment `streamChat` is called. Prevents forgotten tabs and crashed callers from billing tokens to a dead session. On fire → abort with `abortReason='maxDuration'` → `onError` with a distinct message. Owner's explicit constraint: «должны контролировать чтобы токены не утекали вникуда — это бюджет, недопустимо». Default 30 min, user-tunable `ollamaCloud.requestMaxDurationMs` (clamp 60 s–3600 s).

### Settings

| Setting | Default | Clamp | Scope | Status |
|---|---|---|---|---|
| `ollamaCloud.requestConnectTimeoutMs` | 30000 | 1000–120000 | application | new |
| `ollamaCloud.requestInactivityTimeoutMs` | 90000 | 10000–600000 | application | new |
| `ollamaCloud.requestMaxDurationMs` | 1800000 | 60000–3600000 | application | new |
| `ollamaCloud.requestTimeoutMs` | alias → `requestMaxDurationMs` | — | application | deprecated alias |

`requestTimeoutMs` becomes a deprecated alias for `requestMaxDurationMs` to preserve backward compatibility for users who configured the v0.4.0 single timer. The validator resolves the alias and emits a deprecation hint.

### Typed errors (`retry.ts`)

- `ConnectTimeoutError` — connect-phase failure, retryable by `withRetry`.
- `InactivityTimeoutError` — mid-stream silence, terminal, no retry.

### Abort tagging (`ollamaClient.ts`)

`abortReason: 'timeout' | 'maxDuration' | 'cancel' | null` distinguishes the abort cause in `onError`, enabling distinct user-facing messages.

### No mid-stream retry

All three specialists agreed unanimously: do NOT retry mid-stream. POST `/chat/completions` is not idempotent — a retry bills the user twice and shows a duplicate prefix already displayed. This is consistent with ADR 0001 (provider-not-agent — the provider surfaces errors, it does not autonomously retry agent-style) and with `retry.ts:11-17`.

### Security invariants (must hold on implementation — verify before merge)

- **SEC-03** per-connection `allowedBaseUrls` whitelist — unchanged, still enforced at the fetch boundary.
- `redactSensitive` — unchanged, all log paths funnel through the logger.
- `scope: application` on all new settings — workspace folders cannot override them.
- No `child_process` / `eval` / `webview` / `telemetry` — the 9 CI gates enforce this.
- Zero new runtime dependencies.

## Consequences

### Positive

- Legitimate long reasoning is not killed — the inactivity timer resets on every chunk, so an active stream runs as long as it produces output.
- Dead connections are detected within 90 s of silence — far better than the old 120 s end-to-end timer that conflated «dead» with «slow».
- Forgotten tabs and crashed callers are bounded at 30 min — the user's token budget is protected even when the caller forgets to cancel.
- User-tunable — all three thresholds are settings with safe clamps, so users with unusual workloads (very long reasoning, slow cold-start) can adjust.
- Backward compatible — `requestTimeoutMs` is a deprecated alias, existing configurations continue to work.
- Preserves ADR 0001 security posture: SEC-03 whitelist unchanged, redaction unchanged, `scope: application` blocks workspace-folder override, 9 CI gates unchanged, zero new dependencies.

### Negative

- Inactivity 90 s may false-trigger on a non-reasoning model with long first-token latency (e.g. cold-start). Mitigated by user-tunable `requestInactivityTimeoutMs` (clamp 10 s–600 s).
- Max-duration 30 min may kill a legitimate very-long reasoning stream. Mitigated by user-tunable `requestMaxDurationMs` (clamp 60 s–3600 s, up to 1 hour).
- The `: keep-alive` reset path is implemented but Ollama Cloud does not send such comments (spike 1). The reset path is defense-in-depth for future providers that do send keep-alive; on the current provider it is exercised only by the per-chunk reset.

### Neutral

- Three knobs instead of one — documented in README and in the deprecation hint for `requestTimeoutMs`.

## Alternatives considered

| Alternative | Verdict | Reason rejected |
|---|---|---|
| (A) Three timers, max-duration 600 s | rejected | 600 s too low for reasoning with 262K context — a legitimate stream can exceed 10 min |
| (B) Inactivity-only, no max-duration | rejected | No budget protection from forgotten tabs / crashed callers; CancellationToken is voluntary, not a guarantee. Owner sided with SSE: «бюджет, недопустимо утекать» |
| (C) Heartbeat-required (`: keep-alive`) | rejected | Spike 1 confirmed Ollama Cloud does NOT send `: keep-alive` comments during reasoning. Not viable as the sole mechanism |
| (D) Adaptive timeout | rejected | Not formalizable — any concrete implementation reduces to inactivity (B) plus a heuristic, which is strictly worse than a fixed threshold with a tunable clamp |
| (E) Current + raise to 600 s | rejected | End-to-end timer does not reset on chunk arrival — still kills long reasoning. «Бездумное поднятие» — owner rejected |
| (F) No timeout | rejected | Owner: «тупо убрать — антипаттерн». No budget protection, no dead-connection detection |
| Mid-stream retry | rejected | POST `/chat/completions` is not idempotent — retry = double billing + duplicate prefix already shown to user. Unanimous rejection by all three specialists. Violates ADR 0001 (provider-not-agent) and `retry.ts:11-17` |

## Spike results

**Spike 1 — minimax-m3, long reasoning, 5-min curl.** Ollama Cloud does NOT send SSE `: keep-alive` comments during reasoning. However, reasoning models emit `delta.reasoning` chunks continuously — minimax-m3 sent ~50 chunks in 23 s (~0.5 s gap between chunks). Conclusion: a 90 s inactivity threshold is safe — silence greater than 90 s genuinely means a dead connection, not a slow reasoning model. The `: keep-alive` reset path is implemented as defense-in-depth for future providers that do send keep-alive comments.

**Spike 2 — `/v1/responses` endpoint.** Ollama Cloud supports `/v1/responses` (HTTP 200, streaming, tools, vision, background mode). However, resumption via `previous_response_id` does NOT work — `store: true` is ignored by the server, `previous_response_id` returns `null`, and context is not carried across requests. Conclusion: resumption is unavailable on the current tier; the extension cannot use `/v1/responses` to resume a stalled stream without double billing. The timeout fix stays on `/chat/completions`.

A follow-up ADR (0006, future) will address migrating to `/v1/responses` as the PRIMARY endpoint for structured reasoning separation, background async mode, event-based streaming, and `prompt_cache_key`, with `/chat/completions` retained as a fallback for local Ollama instances (which may not support `/v1/responses`). That migration is out of scope for ADR 0005.

## References

- ADR 0001 — Security Goals (provider-not-agent invariant)
- ADR 0003 — Native Provider UX
- ADR 0004 — Vision Fallback Pass-through (introduced minimax-m3 routing, 262K context, increased timeout collision frequency)
- `src/retry.ts:11-17` — «do NOT wrap SSE streaming in retry; only wrap the initial connection»
- `src/connections.ts` — `ConnectionType: 'cloud' | 'local' | 'remote' | 'custom'`; `DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434'` (local Ollama support preserved for the follow-up `/v1/responses` fallback path)
- Issue 14 — original v0.4.0 single 120 s timeout
- Mnemos: 65556243-5b93-4d14-b05e-22648d5e120d
- Follow-up ADR 0006 (placeholder, future) — `/v1/responses` migration as primary endpoint