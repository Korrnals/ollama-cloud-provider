# Changelog

All notable changes to ollama-cloud-provider are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), adheres to [SemVer 2.0.0](https://semver.org/).

## [Unreleased]

### Changed
- _(nothing yet)_

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
