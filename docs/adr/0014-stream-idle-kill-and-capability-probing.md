# 0014. Stream Idle-Kill Classification + Live Capability Probing

**Date:** 2026-09-14
**Status:** Accepted — train A shipped in v0.14.0; train B (`/api/show` probing) shipped in v0.15.0; commit-window planned for 0.15.x

## Deciders

- `@GCW: Tech Lead` (chair, engineering owner) — split the original single release into trains A/B; froze the 50-chunk threshold until the commit-window
- `@GCW: Senior System Engineer` — idle-kill classification; rejected the 500-chunk threshold and fuzzy de-duplication
- `@GCW: Senior Security Engineer` — POST budget, jitter, Authorization policy, N+1 limits for probing
- `@GCW: Product Architect` — honesty requirement ("retry does not heal long thinking"); probing acceptance criterion

Committee verdict: accept-with-conditions on all three positions (protocol 2026-09-14). Review gate for train B: `@GCW: Senior Security Engineer`.

## Context

Owner report (2026-09-14): «частые отвалы и ошибки, пока модель и агенты работают, думают — вероятно, излишние/некорректные логики таймаутов» and «провайдер не видит, что glm-5.3-flash работает с визуалом».

Research findings (2026-09-14, high confidence):

1. **The killer is upstream, not us.** Ollama Cloud drops streams after ~120–145 s of upstream silence (ollama/ollama#16108, open since 2026-05). Retrying the identical POST reproduces the identical silence — the second drop is guaranteed.
2. **Our timers are innocent.** Since ADR 0012 the only remaining bound is the 60 min max-duration ceiling; nothing on our side kills a quiet stream. The owner's timeout hypothesis was disproven and closed publicly via a changelog entry referencing #16108.
3. **Our retry machinery amplified the damage.** Nested `withRetry` × mid-stream retry allowed up to **12 POSTs per message**; the mid-stream backoff had **no jitter** (thundering-herd risk on a synchronous system-wide outage); every >0-chunk retry re-sent the full request and **duplicated already-shown output**; a 0-chunk idle-kill burned 3 × ~145 s (~7 minutes) of doomed waiting and multiple billings before the guaranteed failure.
4. **Capabilities are absent from catalog endpoints.** Cloud `/v1/models` and `/api/tags` return no capability data. The public per-model `POST /api/show` does return `capabilities` (`vision`/`tools`/`thinking`/`completion`; ollama PR #10066; self-hosted servers expose capabilities in `/api/show` since v0.6.4 and in `/api/tags` since v0.30.0). A hardcoded snapshot therefore rots — glm-5.3-flash was misdetectected as text-only.
5. **Confirmed P0 bug:** the global `ollamaCloud.visionModels` override was never applied to the cloud connection in the runtime vision gate (`provider.ts` resolved `connection = undefined` for cloud).
6. **Security finding:** catalog fetches (`/v1/models`, `/api/tags`) bypassed `ssrfGuard` — the guard was wired only into the stream reader.

## Decision

One committee session, two coupled decisions: (1) classify the upstream idle-kill as a terminal, non-retryable failure; (2) resolve model capabilities from live data instead of a rotting snapshot.

### 1. Idle-kill is a terminal class — never retried (train A, shipped in v0.14.0)

A stream that ends (close / RST / clean end) after a quiet gap ≥ 90 s is classified as the #16108 signature and mapped to a new typed error `UpstreamIdleTimeoutError`:

- The gap is `now - lastChunkAt` (or `close - headersAt` when zero chunks arrived); the stream reader tracks both timestamps and the error carries the measured `quietMs`.
- `IDLE_KILL_QUIET_GAP_MS = 90_000` is a code constant in `streamReader.ts` — deliberately **not** user config; it is tuned from diagnostics, not per user.
- Terminal everywhere: excluded from `withRetry`, excluded from mid-stream retry, detected in the 0-chunk probe path and in every catch branch of the stream reader.
- The user-facing error is honest and actionable (from `provider.ts`): «Ollama Cloud: облако закрыло соединение после N с без данных — модель долго размышляла. Известная проблема Ollama Cloud (ollama/ollama#16108), на стороне расширения таймеры стрим не прерывали. Повторите запрос».

Classification as shipped in v0.14.0 (the 50-chunk mid-stream threshold remains until the commit-window replaces it — Decision 5):

```mermaid
flowchart TD
    E["stream ends: close / RST / clean end"] --> G{"quiet gap<br/>(now - lastChunkAt, or<br/>close - headersAt at 0 chunks)"}
    G -- ">= 90 s" --> IDLE["UpstreamIdleTimeoutError<br/>terminal - never retried<br/>honest message + issue 16108"]
    G -- "< 90 s, chunks = 0" --> ZERO["ZeroByteSocketCloseError<br/>retryable (connect phase)"]
    G -- "< 90 s, 0 < chunks <= 50" --> CIE["ConnectionInterruptedError<br/>mid-stream retry: jittered backoff,<br/>visible notice, shared POST budget"]
    G -- "< 90 s, chunks > 50" --> TERM["terminal ConnectionInterruptedError<br/>honest error, manual retry"]
```

### 2. POST budget, jitter, visible retry (train A, shipped in v0.14.0)

- **One shared POST budget per message:** connect-phase (`withRetry`) and mid-stream attempts draw from the same counter, `MAX_POST_BUDGET_PER_MESSAGE = 6` — the worst case drops from 12 POSTs to 6. On exhaustion the stream fails honestly ("POST budget of 6 attempts exhausted — not retrying").
- **Jitter on every mid-stream backoff:** delay = `base * 2^attempt * uniform(0.75..1.25)` (±25 %). No unjittered retries remain on the mid-stream path.
- **Visible retry:** a mid-stream retry issued after output has already been shown surfaces an `onNotice` message; with no handler registered the notice is logged, never dropped.

### 3. Snapshot stopgap, vision-gate P0 fix, ssrfGuard on catalogs (train A, shipped in v0.14.0)

- `glm-5.3-flash` snapshot entry corrected to vision + tools + thinking (verified live via the public `POST /api/show`: capabilities `["completion","thinking","tools","vision"]`, context 1 048 576); `glm-5.3` added (tools + thinking, no vision, same context).
- P0 fix: the runtime vision gate coalesces `connection ?? cloudConnection`, so the global `ollamaCloud.visionModels` override now reaches cloud models.
- `ssrfGuard.assertUrlAllowed` now covers catalog fetches (`/v1/models`, `/api/tags`) through the guard injected into `OllamaClient` — the same defence-in-depth as the stream path (ADR 0012).

### 4. Live capability probing via `/api/show` (train B — shipped in v0.15.0)

Capabilities resolve through layers, first match wins, with the user override always on top:

```mermaid
flowchart TD
    Q["capability question for model M"] --> U{"user override<br/>ollamaCloud.visionModels?"}
    U -- "yes" --> A["override wins<br/>provenance: user"]
    U -- "no" --> S{"M in snapshot table?"}
    S -- "yes" --> B["snapshot entry<br/>provenance: snapshot"]
    S -- "no" --> P["POST /api/show per model<br/>no Authorization (cloud public) - concurrency <= 4<br/>1 attempt, no withRetry - digest cache 24 h - single-flight"]
    P -- "ok, schema valid" --> C["server capabilities<br/>provenance: api-show"]
    P -- "fail / 429 / invalid" --> D["heuristic inference<br/>provenance: inferred - logged, never silent"]
```

Trust rules that make the layers safe:

- the user override (`ollamaCloud.visionModels`) always outranks any server data;
- server-true upgrades an inferred guess;
- server-false never silently downgrades a higher-trust positive — a downgrade must be visible in diagnostics;
- every capability decision records its provenance (`user | snapshot | api-show | inferred`) in diagnostics.

Security conditions of acceptance:

| Area | Condition |
|---|---|
| Authorization | Cloud public `/api/show` is called WITHOUT the API key (traffic hygiene: no key exposure to logging proxies, no tying probe traffic to the account); 401/403 → fallback, the key is never re-sent. Self-hosted connections with `requiresApiKey` send the key, same as `/v1/models`. |
| Network | Both layers on every attempt: `assertBaseUrlAllowedForConnection` (SEC-03 whitelist) + `ssrfGuard.assertUrlAllowed`. |
| Scope | Only models from the same connection's catalog are probed. |
| N+1 limits | Concurrency ≤ 4; cache keyed `(connectionId, model, digest\|modified_at)` with TTL 24 h; single-flight per refresh; exactly one attempt, never wrapped in `withRetry`; 429 → respect `Retry-After`, cancel the remaining batch. |
| Validation | `capabilities` must be an array of strings; unknown values ignored; response size cap; strict schema validation — anything else falls back with `provenance: inferred`. |

### 5. Commit-window as the retry boundary (planned, 0.15.x)

- A ~5 s time-based buffer holds the first deltas before flushing. A break inside the window → one silent retry (disclosed in diagnostics); after the flush the stream is final — mid-stream duplication becomes impossible by construction.
- `MID_STREAM_RETRY_MAX_CHUNKS` (50) is abolished atomically with the window. Removing the threshold alone would silently delete the only working mid-stream retry — rejected in critique.
- Design condition for the same release: non-idle 0-chunk close (< 90 s before the first chunk) gets explicit behaviour — default: one visible attempt when nothing was shown.
- Honesty clause (Product Architect): the commit-window does NOT heal the long-thinking quiet-gap kill — that is #16108 and client-unfixable. It is not presented to the owner as a cure.

Retry-diversification (endpoint switch / `think:false` on the retry attempt) is a spike behind a config flag, OFF by default, in no release until the spike proves a diversified retry survives an idle-kill.

### Invariants

| Invariant | Rule |
|---|---|
| POST budget | Exactly one shared counter per message; hard cap 6 POSTs across connect + mid-stream attempts. |
| Jitter | Every mid-stream retry delay carries ±25 % jitter; no unjittered backoff on the retry path. |
| Idle-kill class | `UpstreamIdleTimeoutError` is terminal — never auto-retried on any path; the 90 s gap is a code constant, not config. |
| Capability layers + trust | Resolution order user → snapshot → api-show → inferred; server-false never downgrades silently; provenance recorded for every decision. |

## Consequences

### Positive

- A #16108 kill now costs one attempt and an honest message instead of ~7 minutes of doomed retries and multiple billings.
- Worst-case POSTs per message halve (12 → 6); jitter removes the thundering-herd contribution; retries after shown output are visible to the user.
- The "new cloud model = text-only" bug class closes structurally once train B lands; the snapshot correction and the vision-gate P0 fix already restore vision for glm-5.3-flash in v0.14.0.
- The SSRF gap on catalog fetches is closed — every outbound request path now passes the guard.

### Negative / accepted

| Risk | Mitigation | Why accepted |
|---|---|---|
| Long thinking stays unprotected until #16108 is fixed upstream | fast honest fail + issue reference in the error text | client-unfixable; we stop paying minutes and duplicate billing for a guaranteed failure |
| The 90 s threshold can misclassify a transient reset with a long quiet gap as an idle-kill | tune the constant from `Mid-stream retry eval` diagnostics | rare; the cost is one manual retry |
| The snapshot table still rots until train B ships | train A entries are a stopgap; train B is the structural fix | train B is accepted and scheduled (v0.15.0) |
| Cloud `/api/show` may change format or close | layered fallback snapshot → inferred with provenance recorded | layers-by-design; the failure is visible, never silent |
| The commit-window (0.15.x) adds ~5 s to visible TTFT on retried streams | the window is covered by the standard VS Code spinner | TTFT of these models is 60–70 s; duplication becomes impossible |
| Non-idle 0-chunk close (< 90 s) classification gap | explicit design item in the 0.15.x review | identified in committee critique; not reachable via the idle-kill path |

## Alternatives considered

| Alternative | Verdict | Rationale |
|---|---|---|
| Raise the mid-stream threshold to 500 chunks (or a compound "chunks AND bytes" rule) | rejected | An identical POST after an idle-kill reproduces identical silence — retry is futile by observed fact; the commit-window replaces the threshold as a class. |
| Fuzzy prefix de-duplication on mid-stream retry | rejected | Regeneration at temperature > 0 does not repeat the text; fuzzy stitching yields garbage. |
| "1–2 attempts" for zero-chunk idle-kill | rejected | Contradicts the verified facts (identical request → identical silence); replaced by the fast honest fail. |
| Full circuit breaker | rejected | Overengineering for a one-user extension; reduced to tuning from diagnostics telemetry. |
| HTML scraping of ollama.com model pages | rejected | Fragile; breaks silently whenever the page layout changes. |
| "Wait for the #16108 fix" as a strategy | rejected | The issue has been open 4+ months with no ETA. |
| Remove the max-duration ceiling | rejected | The forgotten-tab guardrail stays (ADR 0012). |
| Retry-diversification in a release | converted to spike | Unproven; the spike must first demonstrate that a diversified retry survives an idle-kill. |

## References

- Committee protocol (2026-09-14): `~/.gcw/architectural-committee/2026-09-14-ocp-stream-reliability-capability-probing.md`
- Architectural contract: `~/.gcw/architectural-committee/2026-09-14-ocp-stream-reliability-capability-probing-contract.md`
- Mnemos decision id: `f8ecfff4-d417-439b-9916-d6e2d464bd1a` (tags: `project:ollama-cloud-provider`, `committee`)
- ollama/ollama#16108 — Ollama Cloud drops streams after ~120–145 s of silence
- ollama PR #10066 — `/api/show` capabilities
- LiteLLM PR #32204 — external reference recorded in the contract
- ADR 0010 — shared stream reader (the mid-stream retry machinery this ADR constrains)
- ADR 0012 — timer removal + SSRF guard (the baseline this ADR builds on)
- ADR 0013 — two-phase vision fallback (consumer of capability data)
- Code: `src/retry.ts` (`UpstreamIdleTimeoutError`), `src/streamReader.ts` (`IDLE_KILL_QUIET_GAP_MS`, `MAX_POST_BUDGET_PER_MESSAGE`, jittered backoff, notices), `src/provider.ts` (terminal error text, `visionModels` coalesce), `src/modelCatalog.ts` (snapshot)
