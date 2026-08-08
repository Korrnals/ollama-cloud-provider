# 0008. Stream Error Handling — mid-stream errors, classification, and catalog drift

**Date:** 2026-08-03
**Status:** Accepted

## Deciders

- `@GCW: Tech Lead` (chair, engineering owner)
- `@GCW: Product Architect`
- `@GCW: Senior System Engineer`
- Owner (Korrnals) — final decision authority

## Context

The extension is a security-hardened `LanguageModelChatProvider` for Ollama Cloud (ADR 0001). `streamChat` in `ollamaClient.ts` performs POST `/chat/completions` with SSE streaming, gated by the three-timer architecture from ADR 0005 (connect / inactivity / max-duration). ADR 0006 made the `responses` endpoint primary; ADR 0007 introduced context filtering.

The 2026-08-03 committee session was triggered by three independent user symptoms that surfaced within a two-week window:

1. **TLS abort stack trace.** On an aborted TLS handshake the user saw a raw Node `Error: read ECONNRESET` stack trace dumped into the chat transcript — not a clean, actionable error message. The stream surfaced the underlying socket error verbatim instead of a classified, user-facing message.

2. **402 raw stack trace.** On a 402 (payment-required) mid-stream, the user saw a raw `Error: Request failed with status code 402` stack trace. The server's `{"error":"..."}` message body — which names the actual reason (out of quota, card declined, etc.) — was silently discarded; only the HTTP status line surfaced.

3. **kimi-k3 failing.** The `kimi-k3` model failed routing with an unclassified snapshot-mode error. `kimi-k3` was not present in the `SNAPSHOT_MODELS` catalog in `modelCatalog.ts`, so the snapshot-mode branch rejected it instead of routing it through the standard path.

### Root cause (investigated before the committee)

Three distinct defects, each producing one symptom:

| # | Defect | Symptom |
|---|---|---|
| 1 | Mid-stream `{"error":"..."}` chunks from Ollama Cloud are silently skipped by the SSE parser. The parser treats any non-`delta`/non-`[DONE]` chunk as ignorable noise, so a server-sent error mid-stream is dropped and the stream ends as a successful empty completion. | 402 raw stack — the server's message never reaches the user; only the HTTP wrapper surfaces. |
| 2 | `HttpError` (and its peer class) carry the server's response body but `classifyStreamError` does not extract the `{"error":"..."}` field into the user-facing message. The error is classified by HTTP status alone, not by the server's own message. | TLS abort stack — unclassified socket errors surface verbatim. |
| 3 | `kimi-k3` is missing from `SNAPSHOT_MODELS` in `modelCatalog.ts`. The catalog was last updated for `minimax-m3` (ADR 0004); `kimi-k3` shipped after the catalog was frozen. | kimi-k3 fails routing with an unclassified snapshot error. |

The owner rejected four reflexive fixes during the committee (see "Alternatives considered").

## Decision

Five phases. Phases 1–4 are accepted; Phase 5 is rejected.

### Phase 1 — `MidStreamError` (accepted)

Introduce a typed `MidStreamError` in `retry.ts` (peer to `ConnectTimeoutError` / `InactivityTimeoutError` from ADR 0005). The SSE parser in `ollamaClient.ts` recognizes a chunk that is `{"error": <string>}` and throws `MidStreamError` carrying the server's message verbatim, instead of silently skipping it.

- The parser checks for the `error` field on every parsed chunk, before the `delta`/`[DONE]` branch.
- `MidStreamError` is terminal — no mid-stream retry (POST `/chat/completions` is not idempotent, per ADR 0005 "No mid-stream retry").
- `onError` receives `MidStreamError` with `abortReason='midStreamError'`.

This closes the silent-empty-success hole: a server-sent error mid-stream now surfaces as an error, not as a successful empty completion.

### Phase 2 — `classifyStreamError` (accepted)

Extend `classifyStreamError` in `ollamaClient.ts` to extract the server's `{"error":"..."}` message from `HttpError` and `MidStreamError` and place it in the user-facing message. Classification priority:

1. `MidStreamError.message` — the server's own message, verbatim (Phase 1).
2. `HttpError` with a parseable `{"error": ...}` body — extract the `error` field.
3. `HttpError` by HTTP status alone — fall back to status-line classification (existing behaviour).
4. Unclassified socket errors — wrap with a generic "connection interrupted" message instead of surfacing the raw stack trace.

The user now sees the server's message ("out of quota", "card declined", "model not found") instead of a raw stack trace.

#### v0.9.2 revision — `ConnectionInterruptedError` + `isSocketCloseError()`

The original Phase 2 left a gap in priority level 4. Level 4 promised "wrap with a generic 'connection interrupted' message instead of surfacing the raw stack trace" — but a raw Node socket-close `Error` (e.g. `aborted at TLSSocket.socketCloseListener (node:_http_client:...)`, `socket hang up`, `read ECONNRESET`, `connect ECONNREFUSED`) arrived at the streaming clients' outer `catch` as a plain `Error` (name = `'Error'`, **not** `'AbortError'`). Because every `error.name === 'AbortError'` branch in `ollamaClient.streamChat` and `responsesClient.streamResponse` checks the error *name*, these generic socket Errors fell through every branch and surfaced to the user as a raw stack trace. Level 4's wrapping never engaged — the classifier had no typed error to match.

The v0.9.2 fix closes this gap in two parts:

1. **`isSocketCloseError(error)` predicate (`retry.ts`)** — detects raw Node socket/network errors that escaped the `AbortError` routing. It matches conservatively on two signals: the libuv `code` property (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`, `ETIMEDOUT`, `EAI_AGAIN`) and message substrings (`aborted`, `socket hang up`, `read/write/connect` + a code). Our own typed errors (`HttpError`, `MidStreamError`, `ZeroByteSocketCloseError`, etc.) are excluded — they carry their own name and are already classified.

2. **`ConnectionInterruptedError` class (`retry.ts`)** — a new terminal error for mid-stream socket close. When the clients' outer `catch` detects `isSocketCloseError(error)`, they branch on chunks received and reclassify:

   | Chunks received | Reclassified to | Retryable |
   |---|---|---|
   | `0` | `ZeroByteSocketCloseError` (connect-phase equivalent) | yes — no tokens billed |
   | `> 0` | `ConnectionInterruptedError` (mid-stream) | no — tokens already billed, request not idempotent |

`ConnectionInterruptedError` enforces `chunksReceived > 0` at construction (throws `RangeError` otherwise), making the boundary self-documenting. `classifyStreamError` (`provider.ts`) then matches the typed name and surfaces a clean user-facing message ("connection interrupted after N chunk(s)") instead of the raw stack.

**ADR 0005 preserved.** `ConnectionInterruptedError` is terminal and NOT retriable — it carries the "No mid-stream retry" invariant from ADR 0005. Only `ZeroByteSocketCloseError` (0 chunks) is retryable, matching the existing Phase 3 boundary.

### Phase 3 — `ZeroByteSocketCloseError` + ADR 0005 revision (accepted)

Introduce `ZeroByteSocketCloseError` in `retry.ts` for the case where the socket closes with zero bytes received (TLS abort / connection reset before any chunk). This is distinct from `InactivityTimeoutError` (no chunks for 90 s) and from `MidStreamError` (server sent an error chunk):

| Error class | Trigger | Retryable |
|---|---|---|
| `ConnectTimeoutError` | connect-phase timeout | yes (via `withRetry`) |
| `InactivityTimeoutError` | 90 s of mid-stream silence | no |
| `MidStreamError` | server sent `{"error":...}` mid-stream | no |
| `ZeroByteSocketCloseError` | socket closed with 0 bytes received | yes (connect-phase equivalent) |

`ZeroByteSocketCloseError` is retryable because no bytes were received — the request can be reissued without risk of double-billing (no tokens were consumed). This corrects ADR 0005's implicit assumption that any socket close is terminal.

**ADR 0005 revision:** ADR 0005's error table is amended to add `ZeroByteSocketCloseError` as a fourth retryable class (connect-phase equivalent, no bytes received). The "No mid-stream retry" rule is preserved — retry only applies when zero bytes were received, i.e. the request is effectively still in the connect phase. This revision is recorded in ADR 0005's `## Revision history` section as "2026-08-03 — added `ZeroByteSocketCloseError` (ADR 0008)".

### Phase 4 — kimi-k3 catalog (accepted)

Add `kimi-k3` to `SNAPSHOT_MODELS` in `modelCatalog.ts`. The catalog is the single source of truth for which models require snapshot-mode routing; a model missing from the catalog fails routing instead of falling back. Phase 4 is a one-line catalog fix, not an architectural change — it is recorded here because the committee reviewed it as part of the same session and because catalog drift is a recurring failure mode (ADR 0004 froze the catalog for `minimax-m3`; `kimi-k3` shipped after).

**Process note:** catalog updates are now triggered by a `modelCatalog.ts` watch in CI — a new model merged into the upstream catalog triggers a PR to update `SNAPSHOT_MODELS`. This prevents the next `kimi-k3`-class drift from reaching a user.

### Phase 5 — contextFilter safe truncation (REJECTED)

**Position: rejected.** The committee rejected a proposal to extend `contextFilter` to silently truncate context that exceeds the model's window instead of erroring. Rationale:

- Silent truncation hides data loss from the user. A reasoning model that silently drops the middle of the context produces confident-wrong answers — the worst failure mode for a security-hardened provider (ADR 0001).
- ADR 0007's contract is "filter to fit, error if cannot fit safely". Silent truncation breaks that contract.
- The owner's position: «лучше видимая ошибка, чем тихая потеря контекста» — a visible error is preferable to silent context loss.

The rejection is recorded so a future committee does not re-decide the same question without reading the rationale here. Re-opening requires new evidence (e.g. a user-recoverable truncation mode with explicit opt-in).

## Alternatives considered

| Alternative | Verdict | Reason |
|---|---|---|
| Suppress mid-stream `{"error":...}` chunks (status quo) | Rejected | Silent empty success — the worst failure mode. Users see a "successful" empty completion when the server errored. Hides billing-quota issues and model-not-found errors. Phase 1 closes this. |
| Retry mid-stream on `{"error":...}` | Rejected | POST `/chat/completions` is not idempotent (ADR 0005 "No mid-stream retry"). A retry double-bills tokens and may produce a duplicate completion. Mid-stream errors are terminal. |
| Shared SSE parser across `ollamaClient.ts` + `responsesClient.ts` | Rejected (this ADR) | Deferred. ADR 0006 made `responses` primary but both clients still maintain their own parsers. Unifying them is a larger refactor with its own ADR; this committee scoped to error handling only. Tracked as an open question. |
| Token-level truncation in `contextFilter` (Phase 5) | Rejected | Silent data loss. See Phase 5 rationale. |
| Third client for error-classified responses | Rejected | Adds a maintenance surface for a problem solvable in two existing files (`retry.ts`, `ollamaClient.ts`). No new client. |

## Consequences

### Positive

- **Users see real server messages.** A 402 now surfaces "out of quota" (or whatever the server named), not `Error: Request failed with status code 402`. TLS aborts surface "connection interrupted", not a raw stack trace.
- **kimi-k3 works.** Catalog drift is closed for this model; the CI watch prevents the next drift from reaching a user.
- **The silent-empty-success hole is closed.** A mid-stream `{"error":...}` chunk now produces an error, not a successful empty completion. This is the highest-impact fix: it was the failure mode that hid billing-quota issues from users.
- **ADR 0005 is corrected.** `ZeroByteSocketCloseError` is the fourth error class; the "No mid-stream retry" rule is preserved with a precise boundary (retry only when zero bytes received).

### Negative

- **Two new typed error classes** (`MidStreamError`, `ZeroByteSocketCloseError`) in `retry.ts` — small maintenance surface, documented in ADR 0005's amended table.
- **`classifyStreamError` is more complex.** Four-level classification priority instead of status-line-only. The priority order is documented in Phase 2.
- **Catalog watch adds a CI dependency.** The watch triggers a PR on upstream catalog changes; the PR still requires human review before merge.

### Neutral

- ADR 0005 is revised, not superseded. Its three-timer architecture is intact; only the error-class table is amended.
- The shared-parser refactor (rejected alternative) remains an open question for a future ADR.

## References

- **Committee protocol (team-local):** `~/.gcw/architectural-committee/2026-08-03-stream-error-handling.md`
- **Architectural contract (team-local):** `~/.gcw/architectural-committee/2026-08-03-stream-error-handling-contract.md`
- **ADR 0005** — Streaming Timeout Architecture (revised by Phase 3)
- **ADR 0006** — `responses` endpoint primary
- **ADR 0007** — Context filtering (Phase 5 references its contract)
- **Ollama Cloud docs** — `/chat/completions` error envelope `{"error": <string>}`
- **ollama-js reference** — `HttpError` response-body extraction pattern
- **Mnemos decision:** `mnemos_search(tags=["committee", "project:ollama-cloud-provider"])` — decision id recorded in the committee protocol
