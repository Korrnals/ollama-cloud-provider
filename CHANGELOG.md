# Changelog

All notable changes to ollama-cloud-provider are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), adheres to [SemVer 2.0.0](https://semver.org/).

## [Unreleased]

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