# Security Advisories — accepted residuals (v0.21.0/v0.22.0 cascades)

Status: advisory record, not a backlog. Codifies the residuals the v0.21.0/v0.22.0 cascade audits (security + QA) flagged and the owner accepted as shipped at v0.22.0 (main @ 0da9dc3). Nothing here is an open defect. Each entry states the threat, why the residual is accepted, and the cheap hardening that would close it if a future cycle picks it up.

Related: [SECURITY.md](../SECURITY.md) — threat model and shipped mitigations. [compaction-spec.md](compaction-spec.md) — the v0.22.0 contracts two of these residuals ride on.

## A-1 — Compaction injection residual (sec F1; CWE-74 / OWASP LLM01)

**Threat.** The evicted block of a compaction is untrusted conversation content. A summarizer manipulated by directives planted in the evicted turns can emit a summary body that still carries those directives; under stickiness that body rides in the injected checkpoint on EVERY request. The checkpoint frames the body with `SUMMARY_DATA_FRAME_OPEN/CLOSE` delimiters that mark it as DATA, but marking does not constrain: the primary model consumes the frame as ordinary prose, and a directive inside the body is still tokens it reads (`src/compaction.ts`).

**Why accepted.** Against the v0.21.0 baseline — unframed summary, no system data-handling contract — the v0.22.0 cycle added three friction layers:

1. `SUMMARY_DATA_HANDLING_SYSTEM`: the summarizer request carries the data-handling contract as a dedicated `role:'system'` message ahead of the user payload, scoped to the DATA sections (EVICTED BLOCK, PREVIOUS CHECKPOINT) while the operational summary instructions remain binding — role separation is the strongest data/instruction signal a chat model has, and the contract must not depend on instruction precedence inside the one message the hostile block rides in.
2. De-fanged frame delimiters: every exact occurrence of a frame delimiter echoed into the summary body is broken with a mid-delimiter zero-width space at injection time, closing the mechanical echo-escape — an echo-attacking summarizer cannot terminate the DATA frame early or open a second one.
3. Chain-aware wording: the chain-state-specific restatement travels in the user payload, pinned by the `buildSummaryPrompt` contract tests.

The residual that remains is a soft prompt-level risk in the same trust class as any LLM chat client that renders untrusted content into context: the layers raise the cost of manipulation, they cannot make the primary model provably ignore directives carried as data. Structural isolation of summarized content is out of scope for an extension whose whole channel to the model is one message stream.

**Future hardening (optional, rides the compaction fallback contract).** Summary shape validation — reject or trim summaries that do not start with the expected `Goal:` checkpoint shape — plus a length cap on the injected body. Both are local, deterministic, zero-LLM-cost checks that shrink the channel, and a rejected summary must degrade through the existing fallback (compaction never fails the chat), never error the request.

## A-2 — IP-literal https tunnel targets: chain-only validation (sec F3)

**Threat.** For an https baseUrl that is a bare IP literal reached through the HTTP proxy, the tunnel leg builds the TLS layer explicitly over the CONNECT socket (`tls.connect({ socket, … })`, `src/httpClient.ts`). SNI is invalid for literal IPs and no hostname check runs against the certificate — validation is CA-chain-only, so a publicly-trusted certificate issued for another name would be accepted for the IP target.

**Reachability.** The tunnel leg is exercised only when the user has whitelisted an IP-literal https baseUrl in `ollamaCloud.allowedBaseUrls` — an explicit, uncommon configuration; the SSRF guard and whitelist enforcement apply unchanged.

**Why accepted.** Parity with the vanilla Node behavior class: a plain `https.request` to an IP literal performs the same chain-only check. The extension does not weaken the platform default on this leg, and the configuration that reaches it is an explicit user opt-in.

**Future hardening.** Either reject https IP-literal baseUrls at the whitelist boundary, or run a manual `tls.checkServerIdentity(ipLiteral, cert)` after the tunnel handshake and fail the connection on mismatch.

## A-3 — `conv=` fingerprint in INFO logs (sec F5)

**Threat.** The per-request `Compaction check: …` INFO line ends with `conv=<fingerprint>` — the 32-bit FNV-1a fingerprint of the conversation's first user message (over the canonical basis render; `src/provider.ts`, `src/compaction.ts` `fingerprintText`). A 32-bit FNV of a short or low-entropy prompt is offline dictionary-recoverable: an attacker holding the log can test candidate openers against the value and confirm which conversation a log line belongs to.

**Exposure.** Local output-channel logs only. The value never leaves the machine, and reading the channel already requires the local-session access that sees far more than this fingerprint.

**Why accepted.** The fingerprint is load-bearing field diagnostics for the v0.22.0 conversation-keyed compaction state: without it, field logs cannot distinguish "same conversation, projection re-applied" from "new conversation, state re-keyed". A longer hash would not help against dictionary recovery of low-entropy openers — the entropy of the prompt, not the hash width, is the binding constraint.

**Future hardening.** Drop the `conv=` field to debug level (keep the INFO line without it), or move the whole check line to debug once the conversation-keying contract is field-proven.

## A-4 — Per-instance vision maps shared across conversations (sec F7)

**Threat.** The vision resend lifecycle's committed set is per provider instance, not per conversation: `TurnLedger.sentImageHashes` and the companion failed-send/capped maps (`src/turnLedger.ts`) are instance state, in-memory for the window. Predates v0.20.1 and carried unchanged through v0.22.0. An image committed in chat A therefore rides a marker in chat B of the same window: chat B's first send of a byte-identical image is substituted with the `[Image <hash> — …]` marker, and chat B's model answers without seeing the raw image.

**Why accepted — no content disclosure.** Identity is sha256-keyed over the image bytes, so a substitution can fire only for content byte-identical to something the same window already sent — chat B's model is told the image was already analyzed, never shown another conversation's pixels. The failure class is behavior degradation (the model may answer as if it had seen the image), bounded by the marker text stating it has not, and a window reload resets the maps.

**Future hardening.** A per-conversation ledger — key the committed/capped maps by the same first-user-message fingerprint the compaction state already uses, so lifecycle state stops leaking across chat tabs in one window.

## A-5 — Vision pass-through mini-dispatch outside the endpoint seam (QA P3-4)

**Threat class.** Consistency drift, not a direct security hole. `src/visionFallback.ts` (pass-through mode) keeps its own `responses`/`chat` endpoint dispatch — a second copy of the selection logic the TurnContext refactor centralized into the provider's dispatch seam. Any future cross-cutting concern wired only at the seam (a new header, a redaction step, a routing rule) silently misses the vision pass-through leg. The copy already drifts from the seam: it locally resolves `'auto'`/`'native'` to `responses` because native vision pass-through is not implemented.

**Why accepted.** Documented residual from the v0.22.0 TurnContext refactor (wave 2): the dispatch was extracted for the primary chain, and the pass-through leg was deliberately left intact to keep the refactor slice reviewable. The site is marked in-code as mirroring `provider.ts` and as the known second hookup point.

**Future hardening.** Fold the pass-through dispatch into the shared endpoint seam, or extract the endpoint resolution into one helper both sites call — closing the second hookup site for future cross-cutting concerns.

---

Not carried here: QA P3-3 (compaction-spec wording diverging from the implementation's canonical hash-set basis) was a documentation defect, fixed in [compaction-spec.md](compaction-spec.md) in the same change as this record — it is not an accepted residual.
