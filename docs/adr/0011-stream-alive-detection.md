# ADR 0011 — Stream-Alive Detection (Configurable Timeout Mode)

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** Tech Lead (chair), Product Architect, Senior Security Engineer, Senior System Engineer
- **Supersedes:** —
- **Superseded by:** partial — the "TCP keepalive rejected" verdict (Decision; Alternatives row 1) was superseded by ArchCom 0011b (2026-08-11), which shipped TCP keepalive. The Layer-3 config-mode decision stands. See "Revision — 2026-08-11" below.

## Revision — 2026-08-11 (ArchCom 0011b)

One day after this ADR was accepted, ArchCom 0011b **overturned the
"TCP keepalive rejected" verdict** and shipped TCP keepalive
(`socket.setKeepAlive(true, 30000)`) as OS-level dead-connection detection
in v0.11.0, while permanently disabling the inactivity timer (ADR 0005
revision history). The committee's revised position: keepalive is not a
*primary application-progress signal* (the original rejection rationale
holds — a deadlocked Ollama keeps the socket alive), but it is a correct
*secondary OS-level dead-connection detector* when paired with the
max-duration safety cap. The inactivity timer it replaced was a worse
false-positive source than the ambiguity keepalive leaves unresolved.

- **Decision — Layer 1 (TCP keepalive):** shipped in v0.11.0 (no longer deferred).
- **Decision — Layer 3 (configurable timeout mode):** moot — the inactivity
  timer it would configure is permanently disabled.
- **Alternatives row 1 ("TCP keepalive as primary signal — Rejected"):**
  superseded. Keepalive shipped as a secondary signal, not a primary one.
- **Open questions 1 and 2:** closed operationally by the timer removal.

The original text below is preserved as the historical record of the
2026-08-10 deliberation; the keepalive verdict is superseded by this revision.

## Context

The inactivity timer introduced in [ADR 0005](./0005-streaming-timeout-architecture.md)
cannot distinguish a dead server from a legitimately long LLM inference.
When the model pauses longer than the configured inactivity window (default
5 minutes), subagents receive a `ConnectionInterruptedError` even though the
stream is still producing tokens. The error taxonomy in
[ADR 0008](./0008-stream-error-handling.md) classifies this as a transient
interruption, but callers cannot tell whether the cause is "server gone" or
"LLM still thinking" — the same error surfaces for both.

A temporary hotfix increased the inactivity constants. That hotfix shipped
before this ADR and is explicitly a band-aid: it raises the ceiling but does
not resolve the underlying ambiguity. The committee convened to decide a
durable signal for stream liveness.

A TCP keepalive was proposed as the primary liveness signal. The committee
rejected it: TCP keepalive confirms kernel-level socket liveness, not
application progress. A deadlocked Ollama process keeps the socket alive at
the kernel layer while producing no tokens — keepalive would report "alive"
for a stream that is effectively dead. The real signal must come from the
application layer: SSE comment lines (`:`) or Ollama progress events emitted
on the wire.

## Decision

Ship **Layer 3 — configurable timeout mode via
`vscode.workspace.getConfiguration`** as a backward-compatible addition.
Layers 1 (TCP keepalive) and 2 (socket-alive check) are deferred to a
follow-up ADR that lands after the undici migration, because both require
undici and neither resolves the core ambiguity.

The critical finding that shaped this decision: the proposed signal
(TCP keepalive) does **not** resolve "server dead" versus "LLM thinking".
The durable signal must be application-layer — SSE comment lines or Ollama
progress events — and that work is out of scope for this ADR.

## Alternatives considered

| # | Alternative | Verdict | Reason |
|---|---|---|---|
| 1 | TCP keepalive as primary signal | Rejected | Kernel liveness ≠ application progress; deadlocked Ollama keeps socket alive |
| 2 | `socket.readable` without keepalive | Rejected | Linux default `tcp_keepalive_time` is ~2 hours — far too slow to be useful |
| 3 | Per-request timeout mode | Rejected | Policy bypass risk; a caller could silently extend beyond the ceiling (Senior Security Engineer objection) |
| 4 | Only increase constants (hotfix) | Rejected | Band-aid; raises the ceiling but does not resolve the ambiguity |

## Conditions

The accepted decision satisfies five conditions:

1. **Hard, monotonic, non-resettable max-duration ceiling** (60 minutes).
   The ceiling is the upper bound; no configuration or grace extension may
   exceed it.
2. **Timeout mode only via `vscode.workspace.getConfiguration`**, not via
   the provider API. This prevents per-request policy bypass (condition 3's
   rejection rationale applied as a positive rule).
3. **Grace extension gated by the max-duration ceiling.** A grace period may
   extend the inactivity window, but the sum of inactivity + grace may never
   exceed the 60-minute ceiling.
4. **Layer 3 ships independently** as a backward-compatible addition. It does
   not depend on the undici migration and can land on `main` now.
5. **Layers 1 and 2 deferred** to a follow-up ADR after the undici migration.
   Both require undici, and neither resolves the core ambiguity — so they are
   not blocking.

## Consequences

- **Positive:** Subagents gain a configurable timeout mode without waiting
  for the undici migration. The 60-minute ceiling caps worst-case hangs
  regardless of configuration.
- **Positive:** The configuration-only rule closes the per-request bypass
  vector before it is introduced.
- **Negative:** The core ambiguity ("server dead" vs "LLM thinking") is
  **not** resolved by this ADR. Layer 3 only makes the inactivity window
  configurable; it does not add an application-layer heartbeat. That work
  is deferred to the follow-up ADR.
- **Negative:** Operators who set a long inactivity window may still wait
  up to the 60-minute ceiling before a hung stream is interrupted.

## Open questions

1. **Application-layer heartbeat design.** The follow-up ADR must specify
   whether the heartbeat uses SSE comment lines (`:`), Ollama progress
   events, or both. Requires Senior System Engineer input on undici's
   streaming primitives.
2. **Default inactivity window.** Should the default stay at the hotfix
   value, return to the ADR 0005 value, or adopt a new default? Product
   Architect owns this call in the follow-up.

## References

- [ADR 0005 — Streaming timeout architecture](./0005-streaming-timeout-architecture.md)
- [ADR 0008 — Stream error handling](./0008-stream-error-handling.md)
- Committee protocol: `~/.gcw/architectural-committee/2026-08-10-stream-alive-detection.md` (team-local, not committed)