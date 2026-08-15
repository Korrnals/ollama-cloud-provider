# 0012. Single-Timer Streaming Architecture + SSRF Guard

**Date:** 2026-08-12 (revised 2026-08-15)
**Status:** Accepted (revised 2026-08-15 — supersedes the 180s draft below)
**Supersedes:** ADR 0005 three-timer architecture (connect + inactivity timers removed; max-duration ceiling retained)

## Deciders

- `@GCW: Tech Lead` (engineering owner)
- Owner (Korrnals) — final decision authority

## Context

The extension's connect timer (`REQUEST_CONNECT_TIMEOUT_DEFAULT_MS`, **60 s** since v0.9.0 / ADR 0005 revision) wrapped the initial `fetch` + first-chunk probe inside `withRetry` (ADR 0010, Fix 6 in v0.11.0): if no chunk arrived within 60 s, the per-attempt `AbortController` fired, the request was destroyed, and `defaultRetryOn` retried.

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

The retried attempts succeeded — their `Stream start (tool_call)` log lines showed TTFT of 64–70 s. The first attempt was killed at exactly 60 s by `streamReader.ts:353` (`attemptController.abort()` inside the connect-timer `setTimeout`), destroying a request the server was still processing.

### Symptom — "extension disconnects / agent loops"

The owner reported:
- Recurring `ConnectionInterruptedError: соединение прервано в середине ответа` mid-stream.
- Agent loops in GCW sessions — model loses context, repeats steps.

Both symptoms trace to the same root cause: the connect timer kills legitimate slow-TTFT requests, the retry issues a new request, the new request also takes 60–70 s, the cycle repeats until `maxRetries` is exhausted. The user sees the final failure (or, when the abort fires mid-stream after the first chunk, `ConnectionInterruptedError`).

### Why curl does not reproduce

12 curl tests (sequential, parallel, HTTP/1.1, HTTP/2, Node User-Agent) all succeeded against the same endpoint with the same payload. curl has no connect timer — it waits indefinitely for the first byte. The extension's 60 s timer is the sole differentiator.

### Why v0.11.0 did not fix it

v0.11.0 disabled the inactivity timer (ArchCom 0011b/0011c) and added TCP keepalive. The **connect** timer was untouched — it stayed at 60 s. The inactivity timer was a separate false-positive source (long reasoning PAUSES mid-stream); the connect timer is a false-positive source for long reasoning STARTUPS (slow first token). The two are independent, and only the inactivity one was addressed in v0.11.0.

## Decision

Two decisions share this record (same v0.12.0 slice, both shape the request path):

### 1. Remove the connect and inactivity timers — single max-duration ceiling

The connect and inactivity timers are **deleted entirely**. The only remaining bound is a single max-duration timer:

- Setting: `ollamaCloud.requestMaxDurationMin` — default **60** (minutes), range 1–1440 (renamed from ms to minutes in v0.12.0 for usability).
- Purpose: a forgotten-tab safety cap, NOT a request-duration estimate — no reasoning request runs 60 minutes. A genuinely hung stream is cut at the ceiling.

Rationale: any timer that can fire before the first token is a false-positive source by construction — pick a ceiling below some future model's TTFT distribution and the "disconnect / agent loop" symptom returns. The 12 curl tests prove the server honours long TTFT; matching the curl baseline (no pre-first-byte timer at all) removes the failure class instead of tuning it.

`ConnectTimeoutError` / `InactivityTimeoutError` classes and their `defaultRetryOn` checks are removed with the timers.

### 2. SSRF guard — defence-in-depth with dependency injection

`src/ssrfGuard.ts` resolves every outbound request's hostname immediately before `fetch` and rejects protected destinations. It complements (does not replace) the SEC-03 string whitelist in the client — the whitelist cannot catch DNS rebinding, the guard can. The DNS resolver is **injected** (`DnsResolver` type): sinon cannot stub ESM namespace exports (the reason the v0.11.0 SSRF attempt was deleted); DI makes the guard unit-testable without network.

Blocked ranges (both address families):

| Family | Blocked |
|---|---|
| IPv4 | `169.254/16` (link-local / cloud metadata), `10/8` + `172.16/12` + `192.168/16` (RFC 1918), `127/8` (loopback), `100.64/10` (CGNAT), `0/8` (unrouted) |
| IPv6 | `fe80::/10` (link-local), `fc00::/7` (unique-local), `::1` (loopback), `::` (unspecified) |
| IPv4-embedded IPv6 | IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, IPv4-compatible `::a.b.c.d` — the low 32 bits run through the IPv4 classifier (2026-08-15 review fix; previously a bypass) |

Per connection type:

- **cloud** — strict defaults: only public destinations. A block error points at the `ollamaCloud.allowedBaseUrls` whitelist; **no override mechanism exists by design**.
- **local** (user-configured endpoint, e.g. LAN-hosted Ollama at `http://192.168.1.50:11434`) — `allowLoopback: true` + `allowPrivateRanges: true`: RFC 1918 ranges are legitimate destinations there (2026-08-15 review fix — previously hard-blocked, with an error message promising a non-existent override). Link-local `169.254/16` (cloud metadata), CGNAT, `0/8` and ALL IPv6-sensitive ranges stay blocked even for local — cloud metadata never lives in RFC 1918, so those never relax.

## Alternatives considered

| Alternative | Verdict | Rationale |
|---|---|---|
| Keep 60 s, increase `maxRetries` | rejected | Does not fix the root cause — each retry still aborts at 60 s before the first token. Burns the user's quota on duplicate requests that all fail the same way. |
| Raise connect to 180s (initial draft) | rejected same-day | still a false-positive source; any future model with >180s TTFT re-breaks |
| Remove connect timer, keep inactivity timer | rejected | Same false-positive class, different token pattern — long reasoning PAUSES mid-stream re-break it (ArchCom 0011c evidence). |
| Per-model TTFT profile (adaptive timeout) | moot after removal | Correct in principle while a timer exists; once nothing can fire before the first byte there is nothing to adapt. Requires telemetry we do not have. |
| Probe-based liveness (HEAD request before POST) | rejected | Doubles the request count, adds latency to every request, and the probe itself would need a timeout (same problem recursively). |
| No SSRF guard (trust the configured base URL) | rejected | Prompt-injection → attacker-controlled URL is a real path; the DI guard is cheap (one OS-cached DNS lookup), correct and unit-testable. |

## Consequences

### Positive

- **Reasoning models stop being killed at fixed ceilings.** glm-5.2, minimax-m3 and similar slow-TTFT models complete on the first attempt instead of failing-and-retrying.
- **Agent-loop symptom resolved.** The abort → retry → abort cycle that produced the apparent "extension disconnects / agent loops" behaviour cannot start from a timer.
- **`ConnectionInterruptedError` mid-stream occurrences drop sharply.** Most mid-stream aborts in the debug log traced to the connect timer firing just after the first chunk arrived.
- **SSRF hardened, embedded forms included.** Cloud metadata is unreachable via literal, resolved, IPv4-mapped, NAT64 or IPv4-compatible spellings; DNS rebinding (public + private A/AAAA mix) is caught because every resolved address is checked.
- **LAN-hosted local Ollama works out of the box** — loopback + RFC 1918 allowed for `type:'local'` connections (2026-08-15 review fix).

### Negative / accepted

- **A silently-hung connection surfaces only at max-duration** (default 60 min) instead of via a fast connect-timeout error. Accepted: dead connections overwhelmingly fail fast (`ECONNREFUSED`, `ENOTFOUND`); silent hangs are rare; the ceiling is user-tunable in minutes.
- **One extra DNS lookup per unique hostname** before connect (OS-cached afterwards).
- **Local connections trust the LAN.** A malicious LAN host that hijacks the configured endpoint is outside the threat scope of a user-chosen local connection; cloud-guarded paths never relax.

## References

- **Production debug log (team-local):** `7-Ollama Cloud (Debug).log`, session `20260812T032754` — three 60.00 s aborts followed by 64–70 s TTFT on retry.
- **ADR 0005** — Streaming Timeout Architecture (its connect/inactivity timers are removed by this ADR; max-duration retained; "no mid-stream retry" invariant preserved).
- **ADR 0002 / SECURITY.md** — security goals the SSRF guard implements (defence-in-depth).
- **ADR 0010** — Shared Stream Reader (the timers lived in `streamReader.ts`; the max-duration timer remains there).
- **ArchCom 0011b/0011c** — inactivity-timer removal and quality review that preceded this ADR.

## Appendix — superseded draft (180s connect timeout)

> The original draft of this ADR (2026-08-12) proposed raising the connect
> timeout instead of removing the timers. It was rejected the same day in
> favour of full removal; preserved here for the decision trail.

### Context (draft)

The connect timer (`REQUEST_CONNECT_TIMEOUT_DEFAULT_MS`) was set to **60 s** in v0.9.0 (ADR 0005 revision). The timer wrapped the initial `fetch` + first-chunk probe inside `withRetry` (ADR 0010, Fix 6 in v0.11.0): if no chunk arrived within 60 s, the per-attempt `AbortController` fired, the request was destroyed, and `defaultRetryOn` retried.

### Decision (draft)

Raise `REQUEST_CONNECT_TIMEOUT_DEFAULT_MS` from **60 000 ms (60 s)** to **180 000 ms (180 s, 3 min)**. Raise `REQUEST_CONNECT_TIMEOUT_MAX_MS` from 120 000 ms to 300 000 ms (5 min) so a user who explicitly configures a higher value via `ollamaCloud.requestConnectTimeoutMs` is not clamped back below the new default. The 180 s ceiling covered the observed TTFT range (60–70 s) with a 2.5× safety margin while remaining a hard ceiling for genuinely dead connections. Inactivity timer stays disabled; max-duration stays at 30 min; no mid-stream retry; `ConnectTimeoutError` stays retriable.

### Alternatives considered (draft)

| Alternative | Verdict | Rationale |
|---|---|---|
| Keep 60 s, increase `maxRetries` | rejected | Each retry still aborts at 60 s before the first token; burns quota on duplicate failures. |
| Disable the connect timer entirely (like curl) | rejected | Removes the dead-connection safety net; a silently-hung connection would hang forever. |
| Per-model TTFT profile (adaptive timeout) | deferred | Requires a telemetry pipeline we do not have. |
| Probe-based liveness (HEAD request before POST) | rejected | Doubles request count; the probe itself needs a timeout (recursive problem). |
