# Changelog

All notable changes to ollama-cloud-provider are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), adheres to [SemVer 2.0.0](https://semver.org/).

## [Unreleased]

### Fixed
- **Unified zero-byte retry policy (P3-2)** — a non-idle 0-chunk close classified inside `readStreamOnce` (a bare `AbortError` rejecting the first read, or a raw socket-close error escaping `withRetry` after exhausted connect retries) surfaced via `onError` directly, bypassing the "one extra visible attempt" policy that probe-path zero-byte closes already get. Both paths now re-throw `ZeroByteSocketCloseError`, so every zero-byte terminal follows the same policy: exactly one announced extra attempt, then a terminal error. Cancel / max-duration / idle-kill branches are unchanged.

### Changed
- **Hidden-retry counter cleanup (P3-4)** — the commit-window controller is now the single owner of the hidden-retry counter: `readStream`'s local mirror is removed, and both the backoff ordinal and the warn lines read `hiddenRetryCount()` (same source as the `commitWindowHiddenRetries=` field in `Stream done`/`Stream error`). The counter counts SCHEDULED retries — a backoff cancelled by the caller still counts one; the cancel-branch log now states honestly that the retry "was scheduled but cancelled before the POST was issued (no budget burned)".

## [0.16.0] - 2026-09-14

Commit-window — silent early-break healing, 50-chunk mid-stream retry threshold abolished (ArchCom 2026-09-14 §3.4) — plus gate M-package hardening of `/api/show` capability probing and the commit-window review remediation (fix-then-ship). Stream breaks inside the first ~5 s now heal invisibly; after the window a break is terminal and honest: visibility, not chunk volume, decides retryability.

### Security hardening (gate M-package)
- **M1 — `modified_at` staleness hint**: the capability cache entry now stores the server-reported `modified_at` from `/api/show` (optional date string, kept only when parseable), and each probe batch log line gains `oldestCached=HH:MM:SS` (UTC) — or `oldestCached=-` when the server reports none. Full digest-based invalidation on `modified_at` change is deliberately out of scope (backlog: "M1-full").
- **M2 — per-connection 429 backoff**: a 429 from `/api/show` benches the connection (Retry-After seconds, 60 s default); while benched, probe batches for that connection are skipped entirely (empty result + warn, snapshot/heuristic fallback) instead of re-hammering the endpoint on every refresh.
- **M3 — Content-Length pre-check**: probe replies whose declared Content-Length exceeds the 64 KiB cap are rejected before the body is read; the post-read size cap stays as defence-in-depth for lying/absent headers.
- **M4 — louder SSRF probe aborts**: an `SsrfBlockedError` during capability probing now logs at error level (security-relevant block); other probe aborts keep the operational warn.
- **P3-2-DI — injectable SSRF guard factory**: `ModelCatalog` takes an optional `ssrfGuardFactory` (default `createProductionSsrfGuard`); unit tests inject a permissive fake and no longer resolve real DNS.

### Fixed (commit-window review remediation — fix-then-ship)
- **Hidden retry no longer corrupts tool calls (P1-1)** — the compat parser's `pendingToolCalls` accumulation lived once per message, so a silent in-window retry concatenated the discarded attempt's partial tool-call arguments onto the retry's (`{"ci` + `{"city":"Paris"}` → invalid JSON → empty input `{}`). Every attempt now starts with clean protocol state (`onAttemptStart` hook: `pendingToolCalls.clear()` in `ollamaClient`, `pendingEvent = null` in `responsesClient`). "No duplicates by construction" now covers protocol structures, not only visible text.
- **Vision pass-through regained the silent early-break retry (P2-1)** — the vision fallback streams used bare callbacks, losing the commit-window boundary (a mid-stream break became terminal on the first attempt, in silence). Both pass-through runners now wrap their callbacks in a commit window exactly like the primary path, and the zero-byte extra-attempt notice is surfaced inline.
- **Cancellation interrupts the hidden-retry backoff (P2-2)** — a cancelled request used to stay pending for the full backoff delay (up to 10 s) before the next attempt noticed the token; cancellation now resolves the backoff immediately with a quiet completion (`onDone`), without another POST.
- **Thrown terminal stream errors are logged (P3-1)** — a terminal `ConnectionInterruptedError` (thrown after the window closed) bypassed the `Stream error` diagnostics line entirely; it now leaves exactly one line (class + ref + `commitWindowHiddenRetries`), duplicate-guarded against the `onError` path.

### Commit-window — silent early-break healing, 50-chunk threshold abolished (ArchCom 2026-09-14 §3.4)

ArchCom decision `f8ecfff4`.

### Added
- **Commit-window (~5 s, time-based)** — the first deltas of every stream (`onText`/`onThinking`/`onToolCall`) are buffered before they reach the chat. A stream break INSIDE the window is retried **silently**: the buffer is reset, the user sees neither a duplicated prefix nor flicker — only the final answer. The window is armed by the first delta event (not by connection start), so slow thinking-model TTFT (60–70 s) adds zero extra invisible time. Hidden retries are disclosed in diagnostics only: a `Commit-window hidden retry` warn line plus a `commitWindowHiddenRetries=` field in the `Stream done`/`Stream error` report lines. All hidden retries share the per-message POST budget (6).
- **One extra visible attempt for zero-chunk closes** — a non-idle 0-chunk close (< 90 s, nothing received) that survives the connect-phase retries now gets exactly ONE additional attempt announced inline via `onNotice` («Ответ так и не начался — делаю последнюю автоматическую попытку»), then fails terminally. Previously it failed terminally right after the silent connect retries, with no visible cue that anything was attempted.

### Changed
- **The 50-chunk mid-stream retry threshold (`MID_STREAM_RETRY_MAX_CHUNKS`) is abolished** — atomically with the commit-window above. After the window closes (~5 s after the first delta), a mid-stream break is TERMINAL: an honest error («показанный фрагмент может быть неполным… повторите запрос»), manual user retry. Visibility, not chunk volume, now decides retryability; mid-stream text duplication becomes impossible by construction.
- The former visible mid-stream retry notice (re-shown prefix explanation) is gone together with the retry it announced — there is no post-shown auto-retry left to explain.
- Window-retry backoff keeps the ±25 % jitter and is capped at 10 s (1 s base, ×2 per retry).

### Upgrade notes
- Streams that break within the first ~5 s now heal invisibly (covered by the standard VS Code spinner); the visible first token of a healthy stream is unchanged (the buffer flushes after 5 s while tokens keep flowing).
- Tests calling `readStream` directly without a commit-window attached get terminal `ConnectionInterruptedError` on the first mid-stream break (no threshold fallback).

## [0.15.0] - 2026-09-14

Live capability probing via `/api/show` (ArchCom 2026-09-14, train B) + review P2 follow-ups. The class of bug "a NEW model misdetects as text-only until the extension ships a snapshot update" is now closed: capabilities are probed live at catalog refresh.

### Added
- **Live capability probing (`POST /api/show`)** — models discovered on a connection that are MISSING from the hardcoded snapshot are probed against the connection's native `/api/show` endpoint, which returns the authoritative `capabilities` array (e.g. `["completion","thinking","tools","vision"]`). Probed values map to `imageInput`/`reasoning`/`toolCalling` and REPLACE the name-heuristic guess. Works against ollama.com (public, verified live: glm-5.3-flash = vision+tools+thinking) and any self-hosted Ollama ≥ v0.6.4. Capability layers are now: user override (`visionModels`) → snapshot → `api-show` probe → name heuristics.
- **Capability provenance** — every model records where its capabilities came from (`snapshot` / `api-show` / `inferred`); `Ollama Cloud: Show Registered Models` now prints `imageInput`, `reasoning` and the source per model, and each refresh logs one `capability-probe:` batch line (`probed/ok/fallback`).
- **`PostBudgetExhaustedError` (typed)** — when the shared POST budget (6 per message, v0.14.0) runs out, the user now sees an honest localized message naming the cap and the last error class, instead of a generic English `Error` (review P2-1).
- **Integration tests for the v0.14.x invariants** (review P2-2) — the shared POST budget (exactly 6 POSTs, then terminal) and the visible mid-stream retry notice (exactly one notice after already-shown chunks).

### Security (conditions from the architectural contract, all implemented)
- No `Authorization` header on cloud `/api/show` probes (public endpoint — the key must not tie probe traffic to the account); self-hosted connections with `requiresApiKey` send the key as usual; a 401/403 probe result NEVER escalates to a keyed retry.
- One attempt per model (no `withRetry`); 429 cancels the remaining batch (already-collected results kept); response size cap 64 KiB; strict schema validation (`capabilities` must be an array of strings); concurrency ≤ 4; 24 h cache per `(connection, model)`; DNS-rebinding SSRF guard runs before every probe (blocks throw terminally and are logged — never silently degraded).
- Trust rules: probe results only ELEVATE over name heuristics (server-true wins); a server-false never silently demotes a heuristic-true — the disagreement is logged and the heuristic kept; the user's `visionModels` override stays senior at runtime.

### Changed
- Model catalog refresh now probes only snapshot-unknown models (typically 1–3 requests on a warm refresh — snapshot-known models cost nothing extra).

## [0.14.0] - 2026-09-14

Stream reliability under long thinking + vision capability fixes (ArchCom 2026-09-14, train A).

**Why your streams dropped:** the frequent disconnects during long "thinking" phases are an **external Ollama Cloud bug** — the cloud drops streams after ~120-145 seconds of upstream silence during long reasoning / tool-argument composition (ollama/ollama#16108, open since 2026-05). The extension's own timers do NOT cut streams (the only remaining timer is the 60-minute max-duration guardrail; the connect and inactivity timers were removed back in ADR 0012). This release stops paying for that bug with your time and tokens: a deterministic idle kill is detected, reported honestly, and never pointlessly retried.

### Added
- **Idle-kill classification (`UpstreamIdleTimeoutError`)** — a stream closed after ≥90 s of upstream silence (or ≥90 s with no byte after headers) is recognized as the ollama/ollama#16108 signature: terminal, **no auto-retry**. Retrying an identical request reproduces the identical silence and fails again — previously this burned 3 × ~145 s of waiting (up to ~7 minutes) for a guaranteed failure, with each retry re-billing the fresh TTFT. The user now sees an honest inline message: the quiet gap, the upstream issue reference, and an explicit note that the extension's timers did not cut the stream.
- **Visible mid-stream retry notice** — when a mid-stream retry fires *after* output was already shown in the chat, the re-shown prefix would previously read as duplicated/corrupted text. The extension now reports an inline notice (reconnect, attempt N/3) so the regeneration is visible, not silent magic. Delivered via the new optional `onNotice` stream callback.
- **ssrfGuard on catalog fetches** — `/v1/models` and `/api/tags` requests now run the DNS-rebinding SSRF guard (previously only chat streams did). Local connections allow loopback + RFC 1918 as before.

### Changed
- **Shared POST budget (6 per message)** — connect-phase retries and mid-stream retries now share one counter (max 6 POSTs per user message). Previously the nested retry layers could multiply to 12 POSTs worst case on one message.
- **Mid-stream retry backoff now has ±25 % jitter** — prevents synchronized retry bursts when the cloud has a systemic incident affecting all streams at once.

### Fixed
- **glm-5.3-flash misdetects as text-only** — the model is officially vision-capable (`capabilities: ["completion","thinking","tools","vision"]`, verified via the public `/api/show` endpoint). The hardcoded snapshot now declares vision for glm-5.3-flash (context 1 048 576), and glm-5.3 is added too (also verified: vision NOT included; context 1 048 576). Live capability probing via `/api/show` is the follow-up train B (0.15.0).
- **Global `ollamaCloud.visionModels` ignored for cloud models (P0)** — cloud models resolve their connection via the legacy path, where the runtime vision gate read `connection?.visionModels ?? []` and got `[]`. A user-declared vision pattern (e.g. `["glm-5.3-flash*"]`) never reached the gate, so an override-declared vision model was still rejected as text-only. The gate now coalesces with the cloud connection object, which carries the global list.

### Rejected (committee decision)
- Raising the mid-stream retry chunk threshold (50 → 500): retrying an identical POST after an idle kill is provably futile (identical silence → identical failure) and re-bills the generated tail.
- Fuzzy prefix deduplication on retry: a regeneration at temperature > 0 does not reproduce the same text; splicing would corrupt output.
- Full circuit breaker: over-engineering for a single-user extension; a simple cooldown remains a 0.15.x option gated on telemetry.

## [0.13.0] - 2026-08-20

Vision two-phase fallback, mid-stream retry on ConnectionInterruptedError, persistent image-description cache (survives window reload), compaction oscillation + EMA poisoning fixes, Code Review findings applied, release-pipeline hardening.

### Added
- **Mid-stream retry on ConnectionInterruptedError** — `readStream` now wraps `readStreamOnce` in a retry loop (up to 3 attempts, ≤50 chunks, exponential backoff 1s/2s/4s). The Ollama Cloud server regularly closes streams mid-generation after 2-9 chunks (ECONNRESET). Previously this was a terminal error (ADR 0005 "no mid-stream retry" — 0 chunks = 0 billed tokens). With up to 50 chunks already received, retrying is safe (the partial output is discarded on the client; the server bills for the partial generation regardless, but the retry produces a complete answer). This is a fundamental change from ADR 0005: mid-stream socket closes are now retried, not terminal. Resolves the subagent crash loop (`ConnectionInterruptedError` → subagent reports failure → orchestrator retries → same crash). Constants: `MID_STREAM_RETRY_MAX_CHUNKS=50`, `MID_STREAM_RETRY_MAX_ATTEMPTS=3`, `MID_STREAM_RETRY_BASE_DELAY_MS=1000`.
- **Two-phase vision fallback (ADR 0013)** — new default vision
  fallback path. When a text-only primary model receives an image,
  the vision model describes the image (phase 1, non-streaming), then
  the primary model answers using the description (phase 2, normal
  stream). Preserves the user's chosen primary model's reasoning.
  Pass-through (ADR 0004) remains available via
  `ollamaCloud.visionFallback.mode: 'pass-through'`. New file
  `src/visionTwoPhase.ts`; new setting
  `ollamaCloud.visionFallback.mode` (enum: `'two-phase' |
  'pass-through'`, default `'two-phase'`). Image data URLs never
  logged (SHA-256 short hash only); hardcoded describe prompt
  (prompt-injection defence).
- **Persistent image-description cache (v0.13.0 final)** — the
  in-memory description cache (`imageDescriptionCache`, max 100
  entries) is now backed by
  `<globalStorage>/vision-description-cache.json`. VS Code re-sends
  the full conversation history (including image parts) on every
  turn and after every window reload; without persistence, the
  in-memory cache died on reload and every image in history was
  re-described by the vision model on the first post-reload turn.
  The file is written atomically (temp file + `renameSync`) so an
  interrupted write cannot leave a truncated JSON that would
  silently wipe the cache on the next hydration. Cache key is the
  SHA-256 short hash of the image bytes; a hit substitutes the
  stored text description SILENTLY — zero vision-model calls, zero
  "Describing image" annotations. ADR 0013 documents the full
  processed-image lifecycle (marker + cache + substitution). 4 tests
  in `test/unit/visionTwoPhaseCache.test.ts` cover: first describe,
  silent repeat, two distinct images, reload persistence.
- **Context compaction production wiring** (v0.13.0 Slice 2 per
  `docs/compaction-spec.md`, default OFF) — settings
  `ollamaCloud.compaction.enabled` (default `false`) and
  `ollamaCloud.compaction.model` (default `gpt-oss:20b`, used ONLY for
  context summarization, never for chat); `src/compactionStore.ts` —
  content-addressed evicted-block store under
  `<globalStorage>/compaction/<sha256>.txt` with `ocp-compaction://`
  pointers, traversal-proof `resolve` (hash validated as
  `^[0-9a-f]{64}$` before any filesystem access) and mtime-based
  `prune(keep 200)` called opportunistically after each store;
  `src/compactionSummarizer.ts` — single-call, 60s-timeout
  (AbortController + local race), never-retries summarizer wrapper;
  `OllamaClient.nativeChatOnce` — one-shot non-streaming native
  `/api/chat` transport reusing the client's URL/auth/whitelist/SSRF
  path; provider wiring — per-model compaction state map,
  `maybeCompact` runs BEFORE the ADR 0007 context filter and endpoint
  dispatch (the filter then operates on the COMPACTED list; the
  injected `role:'system'` summary message flows through all three
  endpoints unchanged), logs the before/after/evicted/capped/pointer
  stats line and reports ONE `🧠 Context compacted X→Y tokens`
  annotation; summarizer failure logs a warning and proceeds with the
  uncompacted history (accepted degradation). 18 tests added (611 → 629).
- **Context compaction core module** (`src/compaction.ts`, v0.13.0 Slice 1 per
  `docs/compaction-spec.md`) — pure, DI-only module: token estimation,
  hysteresis state machine (compact at 75% of the model window, re-arm at the
  40% target), zone split (system/pinned/evictable/recency; recency = 25% of
  window in tokens or 6 turns, whichever covers more; the cut is repaired so an
  assistant tool_call is never separated from its tool results), sliding-summary
  prompt builder (checkpoint shape: Goal first line, Done, Decisions, Open
  threads, Turn range) and the `compactIfNeeded` orchestrator with the
  never-fail-the-chat fallback contract (summarizer/store errors → passthrough).
  No vscode import; production wiring (cheap-model summarizer, local store,
  provider integration) is Slice 2. 21 unit tests added (582 → 603).

### Fixed
- **Compaction stuck-disarmed (Bug 1)** — `applyCompacted` re-armed
  only at the 40% target. A partial compaction that did not reach 40%
  left the machine disarmed forever, so compaction never fired again
  and context grew unbounded (log: `armed=false` at `usedTokens=2.3M`
  on a 750K-window model). Re-arm now happens at the 75% fire
  threshold (with the 5-minute cooldown guard preventing loops).
- **EMA poisoned by image data URLs (Bug 2)** —
  `updateTokenEstimate` computed `observed = requestChars /
  usage.inputTokens`. `requestChars` includes base64 image data URLs
  (1M+ chars per image), but the server counts image tokens correctly
  (~1K per image), so the ratio became ~1000+ and the EMA dropped to
  `charsPerToken=0.47` after a few vision requests, making every
  token estimate explode. The EMA update is now skipped when
  `observed > 20 chars/token` (text-only requests give `observed≈4`;
  vision requests are excluded entirely).
- **CR #1 (security) — raw response body not redacted** —
  `extractErrorMessage` in `streamReader.ts` logged
  `rawBodyPreview=${body.slice(0, 500)}` without redaction. Server
  error bodies may echo request headers or query params. Now wrapped
  in `redactSensitive()`.
- **CR #2/#14 — HOTFIX_CHAR_CAP block removed** — the
  `ollamaCloud.hotfix.charCap` setting and its 70-line bruteforce
  truncation block in `provider.ts` were a temporary workaround that
  trimmed context instead of using compaction properly. Removed
  entirely; compaction is the correct path.
- **CR #3 — vision-gate DIAG log removed** — the diagnostic log line
  (`vision-gate DIAG: requestHasImages=...`) was added for v0.12.1
- **Release pipeline fail-fast on missing COSIGN_PASSWORD** —
  `scripts/local-ci/run-release-local.sh` step 4 (sigstore cosign)
  now hard-fails when `cosign.key` exists but `COSIGN_PASSWORD` is
  unset, instead of hanging indefinitely on a TTY-less passphrase
  prompt (observed 33-min hang in a background run). Both
  `cosign sign-blob` invocations now read from `/dev/null` as
  defence-in-depth — even a cosign that ignores the env var gets
  EOF on the prompt and fails fast.
  investigation. The investigation is closed; the log is noise in
  production. Removed.
- **CR #4 — Compaction DEBUG log moved to debug level** — was
  `logger.info` (visible in production output); now `logger.debug`
  (visible only when `ollamaCloud.debug` is enabled).
- **CR #6 — duplicate doc-block for `errorRefId` removed** — two
  adjacent JSDoc blocks were merged into one.
- **CR #7 — `classifyStreamError` catch-all preserves
  `LanguageModelError`** — the default HTTP branch and the
  unclassified error branch returned `new Error(...)`, losing the
  `LanguageModelError` type VS Code surfaces consistently. Both now
  return `LanguageModelError.Blocked(...)`.
- **CR #12 — stale "EXPECTED TO FAIL" comment updated** — the
  oscillation test passes since v0.12.0; the comment now reflects
  that it is a regression guard, not an expected failure.
- **Context filter now applies to the native `/api/chat` path (ADR 0007 gap)** — native (the cloud default, `auto` → native) silently bypassed the filter: default cloud users got zero filtering and the `Context filter:` log line never fired. The filtered OpenAI payload now converts via the new `convertOpenAIMessagesToNative` / `convertOpenAIToolsToNative` (no VS Code ↔ OpenAI round-trip); the raw conversion path is preserved when the filter is `off`. `requestChars` is now accurate on the native path too. 12 tests added.
- **P1 (review) — SSRF guard closed IPv4-embedded IPv6 bypass** — `::ffff:169.254.169.254`, NAT64 (`64:ff9b::/96`) and IPv4-compatible (`::a.b.c.d`) forms were never classified against the embedded IPv4 address; all three now run the low 32 bits through the shared IPv4 classifier (mapped loopback respects `allowLoopback`). Unspecified `::` is blocked as well.
- **P1 (review) — LAN-hosted Ollama unblocked on local connections** — RFC 1918 ranges were hard-blocked even for `type:'local'` connections, and the block error promised a non-existent "explicit override". Local connections now set `allowPrivateRanges` (10/8, 172.16/12, 192.168/16 allowed); cloud metadata (169.254/16), CGNAT and all IPv6-sensitive ranges never relax. Error message rewritten; cloud errors point at `ollamaCloud.allowedBaseUrls`.
- **P1 (review) — ADR 0012 rewritten** to match the shipped single-timer + SSRF-guard implementation; the rejected raise-timeout draft is preserved as an appendix.
- **P2 (review) — native converter drops empty `user`/`system` entries** after filtering (mirrors the VS Code-path guard; tool messages unaffected); SSRF error messages strip control characters (log-forging hygiene).
## [0.12.0] - 2026-08-12

Root-cause fix for "extension disconnects / agent loops" + SSRF guard + UX improvements.

### Fixed — root cause of disconnects/loops
- **P0 — native converter dropped tool results (subagent breakage)** — `convertMessagesToNative` dropped user messages whose only content was a `LanguageModelToolResultPart` (the `continue` on empty text skipped the tool-results emit). The model never saw tool outputs, so subagents looped, re-issued calls, and reported success without files changing. Evidence: debug log showed `convertNative: dropped empty user message (parts=1)` 36× in a row. Fix mirrors the compat converter contract: tool results survive even when the host message is empty. 4 regression tests added.
- **Removed connect + inactivity timers (ADR 0012 revised)** — the connect timer (60s) killed legitimate reasoning-model requests with slow TTFT (60-70s). 12 curl tests proved the server never disconnected. Both timers deleted entirely; only max-duration (60min) remains as single hard ceiling.

### Added
- **SSRF guard** (`src/ssrfGuard.ts`) — DNS-resolution-based defence-in-depth. Blocks cloud metadata (169.254.169.254), RFC 1918 private, loopback, IPv6 unique-local. Uses dependency injection (not sinon). 26 unit tests.
- **Context filter tool-integrity integration tests** — 11 tests verifying tool_call_output survives safe/aggressive filtering.

### Changed
- **max-duration: ms → minutes** — `requestMaxDurationMs` renamed to `requestMaxDurationMin`, default 60 (minutes), range 1-1440. User-friendly.
- **Vision params UX** — descriptions rewritten for non-technical users. Three params remain: `enabled`, `model`, `connection` (marked Advanced).
- **`defaultRetryOn` simplified** — removed ConnectTimeoutError/InactivityTimeoutError checks (classes deleted).

### Removed
- `ConnectTimeoutError`, `InactivityTimeoutError` classes
- `resolveConnectTimeoutMs()`, `resolveInactivityTimeoutMs()`
- `ollamaCloud.requestConnectTimeoutMs`, `ollamaCloud.requestInactivityTimeoutMs` settings
- 7 stale tests for removed timer behavior

## [0.11.0] - 2026-08-11

A reliability and security overhaul driven by Architectural Committee findings 0011b (timer architecture) and 0011c (broad quality review). Two rounds of code review passed clean (0 P0, 0 P1). 511 tests pass.

### Added
- **Captive-portal / non-SSE response detection (ArchCom 0011c)** — when bytes arrive but none parse as valid stream events (e.g. an HTML captive-portal page, CDN error page, or proxy interception served at HTTP 200), the stream reader now fires `onError` with a descriptive message instead of silently completing as an empty success. A new `markParsed()` callback lets endpoint parsers signal that a meaningful chunk was processed; `parsedChunks` is tracked separately from raw bytes received.
- **TCP keepalive for dead-connection detection (ArchCom 0011b)** — `setKeepAlive(true, 30000)` on the HTTP socket provides OS-level dead-connection detection, replacing the removed inactivity timer.
- **Capability cache TTL (ArchCom 0011c Fix 1)** — capability-cache entries auto-expire after 5 min, so a model that was 404'd and later restored upstream is re-probed instead of being treated as permanently unavailable.
- **Retired-model hiding (ArchCom 0011c Fix 2)** — a model that returns 404 on 3 distinct requests is marked retired and filtered out of the model picker. Newly-added connections are never filtered. The capability cache is cleared on connection changes so stale 404 entries do not survive a switch (e.g. cloud → VPS).
- **HTTP 429 Retry-After surfacing** — rate-limit errors now include the server-provided `Retry-After` delay (when present) so the user knows how long to wait, instead of a generic rate-limit message.
- **Per-model chars-per-token EMA (ArchCom 0011c Fix 3)** — token estimation now uses a per-model EMA instead of a single global value, so switching between model families (e.g. vision vs English-code) no longer drifts the estimate.
- **Inline vision-fallback annotation (ArchCom 0011b)** — the vision-fallback modal popup is replaced with an inline `LanguageModelTextPart` progress annotation ("🖼️ Processing image via <model>") that flows naturally in the chat thread before the vision-model stream begins.
- **`ollamaCloud.debug` logging channel** — debug entries land in a discoverable "Ollama Cloud (Debug)" output channel; the panel auto-shows when debug mode is enabled mid-session. Noisy per-chunk drop notices demoted from INFO to DEBUG.

### Changed
- **Inactivity timer permanently disabled (ArchCom 0011b/0011c)** — the inactivity timer was a false-positive machine that killed working streams during LLM reasoning pauses (crashed subagents, froze terminals). `resetInactivity` is now a no-op; the max-duration cap (30 min) remains as the only safety net. The dead-code constants and `resolveInactivityTimeoutMs()` are retained for backward-compat.
- **First-chunk probe moved inside the retry wrapper (Fix 6)** — a post-connect 0-byte socket close is now detected inside `withRetry` (by probing the first chunk) and classified as a retryable connect-phase error, instead of surfacing only after the retry window closes. Safe per ADR 0005 (0 chunks = 0 billed tokens, so retry does not double-bill).
- **Socket-leak fix (ArchCom 0011c SSE finding #2)** — on non-abort errors (mid-stream error, buffer overrun, whitelist throw), the response body reader is now cancelled via `controller.abort()` instead of lingering up to the max-duration cap.
- **`gate-npm-audit.sh` promoted to a real gate** — the local CI npm-audit step is no longer an advisory stub.

### Fixed
- **"Validate Configuration" perpetually reported FAILURE** — the command checked two settings (`requestTimeoutMs`, `requestInactivityTimeoutMs`) that were removed from the schema; the checks are deleted and the validation count drops from 8 to 6.

### Removed
- **`requestInactivityTimeoutMs` setting** — removed from the `package.json` schema (the timer is disabled). The legacy alias is still honoured at runtime for migrated users, so existing configs continue to work without edits.
- **`requestTimeoutMs` setting** — removed from the schema, superseded by the connect/max-duration split.
- **`probeUrl` / `probeHeaders` options** — removed from `StreamReaderOptions` and both call sites (the sidecar health-check probe never shipped).

### Notes
- **Breaking-change justification (MINOR during 0.x)** — two settings were removed from the schema and the inactivity timer was architecturally disabled. The runtime still honours the legacy aliases, so existing user configs continue to work without edits. The `StreamReaderOptions` API-surface change affects only internal callers (no published extension API).

## [0.10.1] - 2026-08-10
A diagnostics-focused patch release adding a debug mode for stream-event tracing. Cut to investigate the recurring `ConnectionInterruptedError` (server-side socket close vs client-side abort).

### Added
- **`ollamaCloud.debug` setting** — new boolean setting (default `false`) for stream diagnostics. When enabled, `Logger.debug()` outputs to the Ollama Cloud output channel with per-chunk stream events (line processing, timer config, probe calls).
- **Socket-close diagnostic logging** — the stream reader catch block now distinguishes error paths: client abort (`AbortError` with reason), server-side socket close (0-chunk retryable vs partial-response terminal loss), logging `chunksReceived` + error name/message so the root cause is visible without a reproducer replay.

### Fixed
- **`AbortReason` type corruption (TS1109)** — the type had duplicate members after an edit corruption; restored with correct members (`connect | inactivity | maxDuration | cancel`). `Logger.debug()`, `setDebugMode()`, and `scope:application` on the setting were restored in the same fix.

### Notes
- **SemVer PATCH (0.10.0 → 0.10.1)** — additive diagnostics only, no behavior change for users with debug disabled. The diagnostic output this release added directly informed the inactivity-timer removal and captive-portal detection shipped in [0.11.0].

## [0.10.0] - 2026-08-10

### Changed
- Extracted shared streaming lifecycle into `src/streamReader.ts` — `ollamaClient.ts` and `responsesClient.ts` now call `readStream(options, callbacks)` with endpoint-specific parsing via callback injection, eliminating ~600 lines of duplicated code (ADR 0010). Behavior-preserving: 507 tests pass (+13 new contract tests), 9/9 CI gates green. Preserves ADR 0005 (no mid-stream retry) and ADR 0008 (error taxonomy)
- VSIX no longer bundles old release signatures (`sha256.txt`, `.asc`, `.sigstore.bundle` from v0.9.0–v0.9.3) — `releases/**` added to `.vscodeignore` (~9KB bloat removed)
- SBOM generation switched to Node.js inline generator as primary (correctly lists npm dependencies from `package.json` + `package-lock.json`); `syft` is now opt-in via `SBOM_USE_SYFT=1` (it mis-identified the project as .NET and omitted npm deps)

## [0.9.3] - 2026-08-08

### Fixed
- **4 runtime transitive vulnerabilities cleared via `npm audit fix`** — `undici` (high), `brace-expansion` (moderate), `fast-uri` (moderate), and `js-yaml` (moderate) bumped to fixed versions. No API or behaviour change; these are transitive dependencies reached only at runtime.

### Changed
- **`eol-last` ESLint rule enforced** — the rule now requires every file to end with a newline; 36 source and documentation files were corrected to comply. No logic change.

### Added
- **`isBYOK` stable-API feature-request draft** — `docs/open-issues/vscode-isbyok-stable-api.md` is a ready-to-file GitHub issue for `microsoft/vscode`, requesting promotion of the `isBYOK` field from the proposed `vscode.proposed.chatProvider.d.ts` to the stable `LanguageModelChatInformation` type. Root cause (`AgentHostByokLmHandler` filter) cited; filed as a draft pending owner decision on when/whether to file upstream.

### Known issues
- **3 dev-only vulnerabilities remain** — `mocha`, `diff`, and `serialize-javascript` have advisories, but they are test-time dependencies only and are excluded from the packaged VSIX. No runtime risk to extension users.

## [0.9.2] - 2026-08-08

### Added
- **Models now appear in the VS Code Agents window model picker** when the extension is opted in via `extensions.supportAgentsWindow` — `toChatInformation` sets `isBYOK: true` on the `LanguageModelChatInformation` it returns. The Agents window picker only surfaces models whose `LanguageModelChatInformation` carries `isBYOK === true`; without it, Ollama Cloud models were invisible in the picker even when the extension was active. `isBYOK` is a proposed-only field passed through at runtime via type augmentation (no `enabledApiProposals` needed), mirroring the existing `isUserSelectable` / `statusIcon` augmentation.

### Fixed
- **Raw Node socket-close errors reclassified into typed errors (ADR 0008 Phase 2 level-4)** — a raw Node socket/network error (e.g. `aborted at TLSSocket.socketCloseListener`, `socket hang up`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`, `ETIMEDOUT`, `EAI_AGAIN`) that escaped the streaming clients' `AbortError` routing no longer surfaces to the user as a raw stack trace. New `isSocketCloseError(error)` predicate in `retry.ts` detects these; `ollamaClient.streamChat` and `responsesClient.streamResponse` reclassify them by chunks received (`ZeroByteSocketCloseError` at 0 chunks = retryable; new `ConnectionInterruptedError` at >0 chunks = terminal, non-idempotent per ADR 0005 "No mid-stream retry"); `provider.classifyStreamError` propagates a clean user-facing message instead of the stack trace.
- **Mid-stream connection interrupt now classified as terminal** — a bare `AbortError` (no caller-tag) that arrives AFTER chunks were received is now surfaced as `ConnectionInterruptedError` (terminal — tokens already billed) instead of silently completing as `onDone`.

## [0.9.1] - 2026-08-05

### Fixed
- **`preferredEndpoint` default corrected to `auto`** — the setting default was `"native"`, but the intended behaviour (per ADR 0009) is `auto`, which resolves to `native` (`/api/chat`) for cloud connections and `chat` (`/chat/completions`) for local. The previous `"native"` default worked only because the runtime relied on the package.json default flowing through `config.get()`, which masked a latent bug: no dispatch block matched `primaryEndpoint === 'auto'` literally.
- **Latent `auto`-resolution bug fixed** — `globalPreferred === 'auto'` (the package.json default flowing through `.get()`) is now explicitly resolved to `native` (cloud) / `chat` (local) / `responses` (vision pass-through) at the dispatch point. Without this, changing the default to `auto` would have regressed cloud routing (requests fell through all dispatch blocks unmatched). All four `.get('preferredEndpoint', ...)` call sites aligned to the `'auto'` fallback; the type union widened to include `'auto'`.
- **Regression test added** — `(e) production-default routing` covers the package.json-default-through-`.get()` path that the test harness previously masked.
- **Stale Phase-1 JSDoc removed** — the comment claiming "`auto` resolves to `responses` or `chat` (NOT native)" contradicted the Phase-2 code; rewritten to match ADR 0009.

### Notes
- Requires `package.json` version bump `0.9.0` → `0.9.1` (tracked separately — SSE owns the version line).

## [0.9.0] - 2026-08-04

### Added
- **Endpoint routing with auto-recovery** — the `preferredEndpoint` setting now exposes `auto` / `native` / `responses` / `chat` (enum reordered to list `auto` and `native` first). `auto` selects the endpoint automatically and recovers from transient outages; `native` = `/api/chat` (ndjson, first-class `think`, object `tool_calls`), `responses` = `/v1/responses`, `chat` = `/v1/chat/completions`. Default `native`. Per-connection override unchanged.
- **3×404 auto-recovery from native-endpoint outages** — in `auto` mode, a native (`/api/chat`) 404 no longer switches the connection to the fallback for the rest of the session. Three consecutive 404s within a 5-min sliding window (`shouldAutoSwitch`) trigger the switch to `/chat/completions`; any success resets the counter (`reset404s`); after 5 min of silence the native endpoint is retried (`shouldRetryAfterSilence`), so connections auto-recover without a restart or config change. `sweepStaleEntries` prunes entries older than 10 min (anti-flapping).
- **Soft/grace inactivity timer pattern (ADR 0005)** — replaced the single hard inactivity timeout with a two-phase timer in both `ollamaClient.ts` and `responsesClient.ts`. First fire at the soft threshold (120s) logs a warning and extends to the full grace period; the hard kill fires only after the full grace period elapses with no new chunks. Short-timeout path (≤ 120s) still fires hard directly. Default connect 30s → 60s, inactivity 90s → 300s — total max silence before kill = 120s + 300s = 420s. Accommodates long-reasoning models that go silent between reasoning and token emission without being truly dead.
- **`switchEndpoint` command** — new Ctrl+Shift+P picker (`ollamaCloud.switchEndpoint`) for manual endpoint override. Shows `auto` / `native` / `chat` / `responses` with detail lines and updates the global `preferredEndpoint` setting; the model-picker tooltip refreshes immediately (no reload), capability cache cleared on change.
- **Signing hardening** — release script L2 sigstore layer switched from opt-in keyless mode (interactive OAuth) to always-on keypair mode (`cosign.key` / `cosign.pub`, no browser flow). `cosign.pub` (the public verification key) committed to the repo root so consumers can verify `.sigstore.bundle` artefacts without an out-of-band channel; `cosign.key` stays gitignored.

### Fixed
- **Blocker — native endpoint switched on the first 404 (dead counter)** — `markNativeChatUnavailable` was called on the 1st native 404, bypassing the 3×404 counter entirely. Moved inside the `shouldAutoSwitch` check so native is now retried 3× before switching to `/chat/completions`.

### Changed
- **Timer settings descriptions** — `requestConnectTimeoutMs` / `requestInactivityTimeoutMs` / `requestMaxDurationMs` switched to `markdownDescription` with an `**Advanced**` prefix; the inactivity description now states explicitly that max silence = 120s + the value (420s at default) and that the name reflects the grace ceiling, not the total silence budget.
- **Responses / chat 404 asymmetry documented** — responses and chat still mark the endpoint unavailable on the first 404 (stable endpoints — 1×404 means truly unsupported); only native uses the 3×404 counter (experimental, may flap during rollout).

### Notes
- The flat-schema `convertToolsToResponses` (not nested) for `/v1/responses` shipped in v0.6.1; this release only adds a breadcrumb in `convert.ts` pointing to `convertResponses.ts`.

## [0.8.1] - 2026-08-03

### Fixed
- **Hotfix for broken v0.8.0** — `v0.8.0` shipped with a regression that broke cloud connections; restored the `/v1/responses` dispatch path in the provider and disabled L2 sigstore signing by default (it triggered an OAuth browser flow under the keyless mode). L2 sigstore is re-enabled in v0.9.0 via keypair mode (see above).

## [0.8.0] - 2026-08-03

### Added
- **Native `/api/chat` endpoint for cloud connections** — the extension now uses Ollama's native API (`/api/chat`) as the default for cloud connections, per [docs.ollama.com/cloud](https://docs.ollama.com/cloud). The native endpoint offers first-class `think` field (not vendor-extension), `tool_calls` with object arguments (not string fragments), full-event streaming (no partial accumulation), and Ollama-specific metrics (`total_duration`, `prompt_eval_count`, `eval_count`). See ADR 0009.
- **4-way `preferredEndpoint` override** — the setting now accepts `auto`/`native`/`chat`/`responses`. `auto` resolves to `native` for cloud, `chat` for local. Users can explicitly choose any of the four. Per-connection `preferredEndpoint` overrides the global.

### Changed
- **Cloud default endpoint: `responses` → `native`** — `auto` for cloud connections now resolves to `/api/chat` (native) instead of `/v1/responses`. This is the documented canonical endpoint for Ollama Cloud. Existing users who relied on `/v1/responses` can set `preferredEndpoint: 'responses'` to restore the previous behaviour. See ADR 0006 revision + ADR 0009.
- **`ollamaClient.ts` is now endpoint-format-aware** — accepts `endpointFormat: 'compat' | 'native'` parameter. Native path uses ndjson parser (`processNdjsonLine`), native request schema (`think` top-level, object tool args, `options` field), and `nativeBaseUrl` (`/api` not `/v1`).

### Notes
- Local Ollama connections are unaffected — `auto` for local stays `chat` (compat).
- `visionFallback.ts` still uses `responses` (not migrated to native — separate slice).
- Phase 1 (opt-in native) + Phase 2 (cloud default → native) + Phase 3 (ADR 0006 revision + ADR 0009) = complete endpoint routing feature.

## [0.7.3] - 2026-08-03

### Fixed
- **Zero-byte socket close** — new `ZeroByteSocketCloseError` class in `src/retry.ts` (retryable: 0 chunks = 0 billed tokens, per Ollama Cloud's chunk-based billing). `ollamaClient.ts` and `responsesClient.ts` now surface this error instead of silently calling `onDone` when the server returns HTTP 200 + headers + no body. Closes the "worse than double-billing" hole where a provider outage was masked as a successful empty response. ADR 0005 § "No mid-stream retry" revised (2026-08-03 Architectural Committee): the rule now distinguishes `chunksReceived > 0` (terminal, no retry) from `chunksReceived === 0` (retryable, narrow conditions).
- **HTTP 402/403/429/5xx now surface the server's actual error message** — `classifyStreamError` in `src/provider.ts` prepends the server's `error.message` (extracted from the `{"error":"..."}` body) instead of overwriting with a generic Russian fallback. Users now see the real reason (e.g. "this model uses extra usage only, add extra usage or turn on auto-reload") with a link to ollama.com/settings, not a generic "уменьшите контекст" suggestion.

### Changed
- **Release script (`scripts/local-ci/run-release-local.sh`)** — Step 2 no longer wipes all VSIX in `releases/`; it removes only the current-version VSIX (defence-in-depth against stale same-version repackaging). Rollback VSIX for other versions are preserved. Step 4 (cosign L2 signing) degrades gracefully on any cosign failure (warn + continue) instead of aborting the release; switched from deprecated `--output-signature` to `--bundle` format.

### Notes
- Completes the stream-error-handling hotfix cycle (Phase 3 of the 2026-08-03 Architectural Committee decision; Phases 1, 2, 4 shipped in v0.7.2).
- Endpoint routing (native `/api/chat` for cloud) is the next slice — separate feature, not a hotfix.

## [0.7.2] - 2026-08-03

### Fixed
- **Server-sent mid-stream `error` fields** — new `MidStreamError` class in `src/retry.ts` (non-retriable) carries the server's own error text. `ollamaClient.processLine` and `responsesClient.dispatchResponsesEvent` throw `MidStreamError` when a stream chunk carries an `error` field. Fixes the recurring `aborted: Error: aborted at TLSSocket.socketCloseListener` stack trace: the real server-side cause is now surfaced instead of the TLS socket-close side effect. The HTTP-retry layer no longer re-emits on these errors (explicit non-retriable case in `defaultRetryOn`).
- **HTTP error classification** — new `classifyStreamError` helper in `src/provider.ts` translates `HttpError` 402 (payment required), 403 (forbidden), 429 (rate limit), 404 (not found), and 5xx into human-readable `vscode.LanguageModelError` messages in Russian. `provideLanguageModelChatResponse` is wrapped in try/catch so stream-time errors surface as structured `LanguageModelError` instead of raw `HTTP 402: HttpError: HTTP 402 at ...` stack traces that confused users.

### Added
- **`kimi-k3` in model catalog** — `SNAPSHOT_MODELS` entry mirroring `kimi-k2.6`: 262144 input and output tokens, image input, tool calling, reasoning support. `inferReasoning` recognises the `kimi-k3` prefix.

### Notes
- Hotfix release for stream error handling. Architectural Committee 2026-08-03 accepted Phases 1, 2, 4 (this release); Phase 3 (ADR 0005 revision + 0-byte retry) is deferred to a follow-up slice.

## [0.7.1] - 2026-07-29

### Added
- **README documentation for context filtering** — new `## Context filtering` section (three levels, quality guarantees, configuration, observability), bullet in Key features, row in Configuration table. Consistent with ADR 0007.
- **Provider integration tests for context filtering (#39 review)** — 4 cases: off fast-path (no filter log, unfiltered payload), per-connection safe override (runs the filter when global is off), aggressive truncation (preserves system + last user), tool-call integrity (safe refuses to drop/merge tool-bearing messages).
- **Unit tests for `convertOpenAIMessagesToResponsesInput` (#39 review)** — 6 cases: filtered system hoisted to instructions, subsequent system messages dropped (first becomes instructions), tool-call integrity (1:1 `function_call` + matching `function_call_output` by `call_id`), vision `image_url` preserved as `input_image`, empty assistant message dropped, mixed conversation ordering.

### Changed
- Closed all deferred code-review findings from v0.7.0 (no finding left for follow-up): `chunkCount` increments in all three stream callbacks (#41 F2 — thinking-only and tool-call-only streams no longer log `chunks=0`); token-usage audit uses the pre-update `charsPerToken` (#41 F3 — request-time estimator, not the already-shifted EMA); `Stream error` test asserts `status=` for `HttpError` (#41 F4); redundant connection-lookup ternary collapsed in the endpoint tooltip resolver (#41 F5); per-request `convert audit` log line removed (#41 F6 — verdict is static, `requestChars` already rides on the `Endpoint selected` line).

## [0.7.0] - 2026-07-29

### Added
- **Context filtering (ADR 0007, #39)** — new `src/contextFilter.ts` pure-function module with three user-selected levels: `off` (default, no filtering, zero overhead), `safe` (drop duplicate messages, remove empty content parts, trim whitespace, dedup tools, compact system-prompt whitespace), `aggressive` (safe + context-window truncation preserving system prompt + last user message, merge similar adjacent messages via Jaccard ≥ 0.8, strip non-essential metadata). Global setting `ollamaCloud.contextFilter.level` + per-connection override (`auto` inherits global). Binding tool-call-integrity rule: a dropped `tool_call` always drops its matching `tool_call_output` and vice versa. Vision content (`input_image`) never filtered. Endpoint-agnostic — runs before convert, both `/v1/responses` and `/chat/completions` benefit. Zero runtime dependencies preserved. 57 new tests.
- **ADR 0007** — Context Filtering (Pre-Model Payload Processing). Nygard format, documents the three-level scheme, non-goals (no automatic mode, no semantic compaction, no tokenizer), and six rejected alternatives.

### Fixed
- **Endpoint fallback policy (#40)** — when `preferredEndpoint` is explicitly set (per-connection `responses`/`chat` OR a global setting the user actually configured), a 404 from that endpoint NO LONGER silently falls back. The provider throws `LanguageModelError.NotFound` with an actionable hint (switch to `auto` for fallback, or switch to the other endpoint). When `preferredEndpoint` is `auto` (default), the prior fallback + log-warning behaviour is preserved. Capability-cache short-circuit guard for explicit mode. `clearCapabilityCache()` on `preferredEndpoint` config change. Local Ollama unaffected (always `/chat/completions`).

### Changed
- **Comprehensive refactoring (#41)** — logging expanded from 63 to 79 `logger.*` calls across `src/`. Stream lifecycle logs (time-to-first-token, duration, chunk count, error class + status). Endpoint indicator in model picker tooltip (`Endpoint: /v1/responses` / `auto (resolves to ...)` / `/chat/completions (local)`), refreshed on config change. Token-usage audit: `formatUsageLog` now reports estimated tokens (char-based proxy) alongside server-reported usage, with a `delta=` line when the gap exceeds 20%. Convert-path drop/coerce diagnostics. Per-connection catalog sync logging. Retry decision logging with attempt + delay + error class. No status bar item (log + tooltip only, per owner decision). No behaviour change beyond richer logs and a longer tooltip.

## [0.6.1] - 2026-07-28

### Fixed
- **Proxy-aware HTTP client** — new `httpClient.ts` using Node.js native `https`/`http` modules, bypassing VS Code's `global.fetch()` interception. Fixes connect-timeout issues when `chat.agent.sandbox.enabled: "on"`. Reads the `http.proxy` VS Code setting (HTTPS via CONNECT tunnel, HTTP via direct proxy request). Both `OllamaClient` and `ResponsesClient` use the new `httpRequest()` instead of `fetch()`. Zero new dependencies.
- **Critical regression**: `/v1/responses` tool calling completely broken in v0.6.0. Tool results (`LanguageModelToolResultPart`) were incorrectly wrapped as `tool_call_output` content parts inside a `role:'user'` message, which the Ollama Cloud server rejects with `unknown content type: tool_call_output`. Tool calls (`LanguageModelToolCallPart`) from assistant messages were silently dropped, breaking multi-turn tool use entirely. Both are now emitted as top-level `function_call` / `function_call_output` input items per the OpenAI Responses API spec.
- `ResponsesInputItem` type changed from a single interface to a discriminated union (`message` | `function_call` | `function_call_output`) to accurately model the `/v1/responses` input schema.
- `ResponsesContentPart` no longer includes `tool_call_output` — it was never a valid content part type.

### Added
- **Global `ollamaCloud.preferredEndpoint` setting** — choose primary API endpoint (`responses` (default) or `chat`) via VS Code Settings UI or `settings.json`. The other endpoint is the automatic fallback on HTTP 404. Per-connection `preferredEndpoint` in `ollamaCloud.connections` overrides this global setting. Local Ollama connections always use `/chat/completions` regardless.
- **Symmetric fallback** — when `preferredEndpoint` is `chat` and `/chat/completions` returns 404, the extension falls back to `/v1/responses` (and vice versa). The capability cache now memoizes 404s for both endpoints.
- **Capability cache extended** — `isChatKnownUnavailable`, `markChatAvailable`, `markChatUnavailable` added to `capabilityCache.ts` for symmetric fallback support.
- 3 new unit tests for `/v1/responses` tool conversion: `function_call_output` top-level item, `function_call` top-level item, and full tool-use round-trip ordering (function_call → function_call_output).

## [0.6.0] - 2026-07-28

### Added
- `/v1/responses` as primary endpoint for cloud connections (ADR 0006). Structured streaming with typed events (`response.created`, `response.reasoning_summary_text.delta`, `response.output_text.delta`, `response.completed`). Reasoning surfaced via `LanguageModelThinkingPart` (collapsed thinking block in Copilot Chat). `/chat/completions` retained as fallback for local Ollama + HTTP 404 + user override.
- `ResponsesClient` — new client for `/v1/responses` endpoint with two-line `event:`+`data:` SSE parser, ADR 0005 timeout architecture inheritance (3 timers, per-attempt AbortController).
- `convertResponses.ts` — messages → `input[]` format with system prompt → `instructions` field hoist.
- `capabilityCache.ts` — per-connection 404 memoization (fallback cache).
- `ConnectionConfig.preferredEndpoint` — `'responses' | 'chat' | 'auto'` (default `'auto'` for cloud, `'chat'` for local).
- `Ollama Cloud: Refresh Models` command — force-sync model catalog with progress notification.
- Auto-refresh model catalog on startup (`syncModelCatalog(true)` on activation).

### Changed
- Provider dispatch: cloud connections now try `/v1/responses` first, fall back to `/chat/completions` on 404. Local connections use `/chat/completions` directly.
- Vision fallback (ADR 0004) uses same endpoint dispatch as primary provider.
- Structured reasoning: `onThinking` callback → `vscode.LanguageModelThinkingPart` (VS Code 1.103+, graceful fallback to `LanguageModelTextPart`).

### Security
- SEC-03 `allowedBaseUrls` whitelist enforced on both `/v1/responses` and `/chat/completions` endpoints.
- `redactSensitive` covers all log paths in both clients.
- `scope: application` on `preferredEndpoint` setting.
- No `child_process`/`eval`/`webview`/`telemetry` — 9 CI gates enforce.
- Zero new runtime dependencies.
- No mid-stream fallback (double billing prevention, ADR 0001/0005).
- No stateful features (previous_response_id, store, background — all omitted, thin provider per ADR 0001).


## [0.5.3] - 2026-07-27

### Fixed
- Connect timer now uses a per-attempt `AbortController` (ADR 0005 bug fix). Previously, the connect timer reused the main controller — when it fired, the signal was aborted permanently and all retry attempts failed instantly. Now each retry attempt gets a fresh controller; retry works correctly on connect timeout.

## [0.5.2] - 2026-07-27

### Fixed
- Streaming timeout architecture (ADR 0005): replaced single 120s end-to-end timer with three timers — connect (30s, retry), inactivity (90s, reset per chunk), max-duration (30 min safety cap). Long-reasoning models (minimax-m3, 262K context) no longer killed by false timeout; dead connections detected; forgotten-tab budget protected. No mid-stream retry (double billing prevention).

### Added
- Settings: `requestConnectTimeoutMs` (30000, range 5000-120000), `requestInactivityTimeoutMs` (90000, range 10000-600000), `requestMaxDurationMs` (1800000, range 60000-3600000). `requestTimeoutMs` deprecated as alias → `requestMaxDurationMs` (backward compat, deprecation warning logged once).
- `ConnectTimeoutError` (retriable), `InactivityTimeoutError` + `MaxDurationError` (terminal) in `retry.ts`.
- ADR 0005: streaming timeout architecture decision record.
- 8 new integration tests in `test/integration/ollamaClient.test.ts` (321 total passing).

## [0.5.1] - 2026-07-23

### Changed
- README rewritten as professional public-facing page (Marketplace + GitHub). Removed internal/dev/CI noise. Marketplace install added as recommended path.

### Notes
- Docs-only release. No code changes. Version bump to refresh Marketplace README (Marketplace reads README from VSIX, not from GitHub).

## [0.5.0] - 2026-07-22

### Added
- Vision Fallback Pass-through (ADR 0004): when primary model cannot handle vision and user enables `ollamaCloud.visionFallback`, extension swaps to a user-configured vision-capable model for that turn. Settings: `visionFallback.enabled`, `visionFallback.model`, `visionFallback.connection` (all scope:application). Commands: `Ollama Cloud: Set Vision Fallback Model`, `Ollama Cloud: Set Vision Fallback Connection`.
- CancellationToken race fix in `ollamaClient.streamChat` (synchronous `isCancellationRequested` check before first await).

### Fixed
- `redactSensitive` now masks `data:image/*;base64,...` payloads (defense-in-depth, v0.4.0 security audit finding #1).
- Stale `visionFallback.connection` now logs a warning and falls back to primary (M2).
- QuickPick "Set Vision Fallback Connection" now offers a "Clear — use primary connection" option (M3).

### Security
- v0.4.0 security audit: PASS WITH NOTES, no regression vs v0.3.0. All 8 invariants hold on new code (multi-connection + vision).
- Vision Fallback code review: APPROVE WITH NOTES, all 10 ADR 0004 constraints verified.
