# 0012. Connect Timeout — 180s for reasoning-model TTFT ceiling

**Date:** 2026-08-12
**Status:** Accepted
**Supersedes:** ADR 0005 connect-timer default (60s) — partial revision

## Deciders

- `@GCW: Tech Lead` (engineering owner)
- Owner (Korrnals) — final decision authority

## Context

The extension's connect timer (`REQUEST_CONNECT_TIMEOUT_DEFAULT_MS`) was set
to **60 s** in v0.9.0 (ADR 0005 revision). The timer wraps the initial
`fetch` + first-chunk probe inside `withRetry` (ADR 0010, Fix 6 in v0.11.0):
if no chunk arrives within 60 s, the per-attempt `AbortController` fires,
the request is destroyed, and `defaultRetryOn` retries.

### Evidence — production debug log (2026-08-12)

A debug-mode capture from the owner's environment (`7-Ollama Cloud
(Debug).log`, session `20260812T032754`) showed a recurring pattern: the
connect timer fired BEFORE the first chunk arrived on requests that
ultimately WOULD have succeeded. Three consecutive failures, each exactly
60 s after `readStream START`:

| `readStream START` | `AbortError` | Elapsed | Stream start (later retry) | TTFT |
|---|---|---|---|---|
| `00:36:54.720` | `00:37:54.728` | **60.008 s** | `00:37:58.694` | **63.975 s** |
| `00:38:02.323` | `00:39:02.326` | **60.003 s** | `00:39:12.616` | **70.294 s** |
| `00:39:32.144` | `00:40:32.146` | **60.002 s** | `00:40:36.760` | **64.618 s** |

The retried attempts succeeded — their `Stream start (tool_call)` log lines
showed TTFT of 64–70 s. The first attempt was killed at exactly 60 s by
`streamReader.ts:353` (`attemptController.abort()` inside the connect-timer
`setTimeout`), destroying a request the server was still processing.

### Symptom — "extension disconnects / agent loops"

The owner reported:
- Recurring `ConnectionInterruptedError: соединение прервано в середине
  ответа` mid-stream.
- Agent loops in GCW sessions — model loses context, repeats steps.

Both symptoms trace to the same root cause: the connect timer kills
legitimate slow-TTFT requests, the retry issues a new request, the new
request also takes 60–70 s, the cycle repeats until `maxRetries` is
exhausted. The user sees the final failure (or, when the abort fires
mid-stream after the first chunk, `ConnectionInterruptedError`).

### Why curl does not reproduce

12 curl tests (sequential, parallel, HTTP/1.1, HTTP/2, Node User-Agent)
all succeeded against the same endpoint with the same payload. curl has
no connect timer — it waits indefinitely for the first byte. The
extension's 60 s timer is the sole differentiator.

### Why v0.11.0 did not fix it

v0.11.0 disabled the inactivity timer (ArchCom 0011b/0011c) and added
TCP keepalive. The **connect** timer was untouched — it stayed at 60 s.
The inactivity timer was a separate false-positive source (long
reasoning PAUSES mid-stream); the connect timer is a false-positive
source for long reasoning STARTUPS (slow first token). The two are
independent, and only the inactivity one was addressed in v0.11.0.

## Decision

Raise `REQUEST_CONNECT_TIMEOUT_DEFAULT_MS` from **60 000 ms (60 s)** to
**180 000 ms (180 s, 3 min)**. Raise `REQUEST_CONNECT_TIMEOUT_MAX_MS`
from 120 000 ms to 300 000 ms (5 min) so a user who explicitly configures
a higher value via `ollamaCloud.requestConnectTimeoutMs` is not clamped
back below the new default.

The 180 s ceiling covers the observed TTFT range (60–70 s for glm-5.2
under load, similar for minimax-m3) with a 2.5× safety margin. It is
still a hard ceiling — a genuinely dead connection (no response, no
TCP RST) is aborted after 180 s, then retried per `defaultRetryOn`
(`ConnectTimeoutError` is retriable).

### What is NOT changed

- **Inactivity timer** remains disabled (ArchCom 0011c) — the connect
  timer change does not re-enable it.
- **Max-duration** stays at 1 800 000 ms (30 min) — the forgotten-tab
  safety cap is preserved.
- **No mid-stream retry** (ADR 0005) — once the first chunk arrives,
  the stream is non-idempotent; the connect timer only governs the
  connect/first-token phase.
- **`ConnectTimeoutError` is still retriable** — `defaultRetryOn`
  returns `true` for it. A 180 s timeout × `maxRetries` (default 3) =
  up to 9 min total wait for a genuinely dead connection before the
  final failure surfaces. This is acceptable: a genuinely dead
  connection surfaces as `ECONNREFUSED`/`ENOTFOUND` immediately (not
  via timeout); the 180 s timeout only fires on silent hangs.

## Alternatives considered

| Alternative | Verdict | Rationale |
|---|---|---|
| Keep 60 s, increase `maxRetries` | rejected | Does not fix the root cause — each retry still aborts at 60 s before the first token. Burns the user's quota on duplicate requests that all fail the same way. |
| Disable the connect timer entirely (like curl) | rejected | Removes the dead-connection safety net. A silently-hung connection (TCP dropped, no RST) would hang forever, consuming a model slot. 180 s is a bounded compromise. |
| Per-model TTFT profile (adaptive timeout) | deferred | Correct in principle — glm-5.2 vs gpt-oss:20b have different TTFT distributions — but requires a telemetry pipeline we do not have. A fixed 180 s ceiling is the pragmatic v0.12.0 fix; adaptive timeout is an open question for a future ADR. |
| Probe-based liveness (HEAD request before POST) | rejected | Doubles the request count, adds latency to every request, and the probe itself would need a timeout (same problem recursively). |

## Consequences

### Positive

- **Reasoning models stop being killed at 60 s.** glm-5.2, minimax-m3,
  and similar models with 60–70 s TTFT under load now complete
  successfully on the first attempt instead of failing-and-retrying.
- **Agent-loop symptom resolved.** The retry cycle (abort → new request
  → abort → ...) that produced the apparent "extension disconnects /
  agent loops" behaviour no longer fires for slow-TTFT requests.
- **`ConnectionInterruptedError` mid-stream occurrences drop
  sharply.** Most mid-stream aborts in the debug log traced to the
  connect timer firing just after the first chunk arrived (the
  `mainAbortListener` path at `streamReader.ts:367`). With a 180 s
  ceiling, the timer does not fire during the normal TTFT window.

### Negative

- **Genuinely dead connections take up to 180 s × `maxRetries` to
  surface.** Mitigated: dead connections typically fail fast
  (`ECONNREFUSED`, `ENOTFOUND`), not via timeout. The 180 s timeout
  only fires on silent hangs, which are rare.

### Neutral

- ADR 0005 is revised, not superseded. The three-timer architecture is
  intact; only the connect-timer default constant changes. The
  "No mid-stream retry" invariant is preserved — the connect timer
  only governs the connect/first-token phase, which is retryable per
  ADR 0005 (0 chunks = 0 billed tokens).

## References

- **Production debug log (team-local):** `7-Ollama Cloud (Debug).log`,
  session `20260812T032754` — three 60.00 s aborts followed by 64–70 s
  TTFT on retry.
- **ADR 0005** — Streaming Timeout Architecture (connect timer is
  revised by this ADR; inactivity timer disabled separately by ArchCom
  0011c).
- **ADR 0008** — Stream Error Handling (`ConnectTimeoutError` is
  retriable per `defaultRetryOn`; this ADR changes the ceiling, not
  the retryability).
- **ADR 0010** — Shared Stream Reader (the connect timer lives in
  `streamReader.ts:348-353`; the 180 s constant is in the same file).
- **ArchCom 0011b/0011c** — inactivity-timer removal (separate from
  this ADR; both timers are now tuned for reasoning-model reality).
