<p align="center">
  <img src="media/banner.png" alt="Ollama Cloud Provider" width="100%" />
</p>

[![Version](https://img.shields.io/visual-studio-marketplace/v/Korrnals.ollama-cloud-provider?style=flat-square&label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=Korrnals.ollama-cloud-provider)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Korrnals.ollama-cloud-provider?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=Korrnals.ollama-cloud-provider)

# Ollama Cloud Provider ✨

**Use Ollama Cloud models in VS Code Copilot Chat.**

## 📖 Overview

Ollama Cloud Provider registers Ollama Cloud models as native VS Code language models, making them available in the Copilot Chat model picker. Configure an API key, select a model, and chat — no wrappers, no extra UI, no separate chat window.

The extension is built for reliability and safety: API keys live in OS-backed secret storage, requests only go to URLs you explicitly allow, and every release is signed and checksummed.

## Contents

- [Quick start](#quick-start)
- [Key features](#key-features)
- [Security posture](#security-posture)
- [Installation](#installation)
- [Setup](#setup)
- [Configuration](#configuration)
- [Commands](#commands)
- [Model sync](#model-sync)
- [Endpoint routing](#endpoint-routing)
- [Context filtering](#context-filtering)
- [Vision fallback](#vision-fallback)
- [VS Code Agents window](#vs-code-agents-window)
- [License](#license)

## 🚀 Quick start

Three steps from install to first message.

1. **Install** — from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Korrnals.ollama-cloud-provider) or `code --install-extension Korrnals.ollama-cloud-provider`.
2. **Set your key** — `Ctrl+Shift+P` (or `Cmd+Shift+P`) → `Ollama Cloud: Set API Key`. Get one at [ollama.com](https://ollama.com/).
3. **Chat** — open Copilot Chat, pick an Ollama Cloud model from the picker, and send a message. Run `Ollama Cloud: Check Connection` first if you want to confirm the endpoint.

The default endpoint (`auto`, which resolves to `native` `/api/chat` for cloud) works out of the box. No `settings.json` edits required for a standard cloud setup.

## ⭐ Key features

- **Native Copilot Chat integration** — Ollama Cloud models appear in the Copilot Chat model picker as first-class VS Code language models.
- **Endpoint routing with auto-recovery** — four-way `preferredEndpoint` (`auto` / `native` / `responses` / `chat`). The default is `auto`, which resolves to `native` (`/api/chat`) for cloud and `chat` (`/chat/completions`) for local. In `auto` mode, `native` switches to `/chat/completions` only after 3 consecutive 404s in a 5-min window and returns to `native` after 5 min of silence — connections self-heal without a restart. See [Endpoint routing](#endpoint-routing) and ADR 0009.
- **Native `/api/chat` for cloud, OpenAI-compat for local** — cloud uses Ollama's native API by default (first-class `think`, object `tool_calls`, full-event streaming, Ollama metrics). Local uses `/chat/completions` (OpenAI-compat, SSE).
- **Secret storage** — API keys are stored in the OS-backed secret store, never in `settings.json` or workspace files.
- **Context filtering (token savings)** — optional pre-processing that drops duplicate messages, empty content parts, and redundant tool definitions, and compacts the system prompt — reducing token cost without touching semantic content. Tool-call integrity is guaranteed; vision content is never filtered. Three levels (`off` / `safe` / `aggressive`), `off` by default. See [Context filtering](#context-filtering).
- **Structured error surfacing** — server-sent mid-stream errors (`{"error":"..."}`) are caught as `MidStreamError` and shown with the real server message. HTTP 402/403/429/5xx are classified into human-readable `LanguageModelError` messages (including the server's actual reason, e.g. "this model uses extra usage only"). Raw Node socket-close errors (the `aborted at TLSSocket.socketCloseListener` / `socket hang up` / `ECONNRESET` family) are reclassified by `isSocketCloseError()` into `ConnectionInterruptedError` (mid-stream, terminal) or `ZeroByteSocketCloseError` (connect-phase, retryable) — shown as a clean message instead of a raw stack (v0.9.2, see ADR 0008).
- **Mid-stream retry (v0.13.0)** — when the Ollama Cloud server closes the stream mid-generation (ECONNRESET after 2–9 chunks), `readStream` now retries up to 3 attempts with exponential backoff (1 s / 2 s / 4 s), bounded to ≤ 50 chunks already received. This resolves the subagent crash loop where `ConnectionInterruptedError` killed `runSubagent` calls. ADR 0005 previously stated "no mid-stream retry"; this is updated — with up to 50 chunks, the server bills for the partial generation regardless, but the retry produces a complete answer.
- **Proxy-aware networking** — a native HTTP client bypasses VS Code's `global.fetch()` interception, fixing connect-timeout issues under `chat.agent.sandbox.enabled: "on"`. Respects the `http.proxy` VS Code setting.
- **Tool calling** — fully supported on `/v1/responses` (top-level `function_call` / `function_call_output` items) and on native `/api/chat` (object tool args). Handled natively by VS Code, with no shell execution from the extension.
- **Automatic model sync** — model catalog auto-refreshes on startup and when connection settings change. Use `Ollama Cloud: Refresh Models` to force a sync at any time.
- **Multi-connection** — connect to several OpenAI-compatible endpoints (Cloud, Local, VPS, custom) with per-connection API keys and URL whitelists.
- **Retry and streaming timeouts** — exponential backoff for transient failures, plus OS-level TCP keepalive for dead-connection detection and a max-duration safety cap.
- **Streaming protection (ADR 0005)** — two layers protect against dead connections without killing legitimate long-reasoning streams: **connect** 60 s (retried via `maxRetries`), and a **max-duration** safety cap of 30 min (never reset, prevents forgotten-tab token leaks). Dead connections are detected at the OS level via TCP keepalive (`setKeepAlive(true, 30000)`) rather than by an inactivity timer — the previous inactivity timer was a false-positive machine that killed working streams during LLM reasoning pauses, and is now permanently disabled (v0.11.0, ArchCom 0011b/0011c).
- **Manual endpoint override** — `Ollama Cloud: Switch Endpoint` opens a picker to override the endpoint (`auto` / `native` / `chat` / `responses`) at any time, without editing `settings.json`.
- **Health check** — probe the endpoint and discover models before chatting.
- **Configuration validation** — catch misconfiguration (missing key, URL not whitelisted) before it breaks a chat.

## 🔒 Security posture

Security is a first-class concern:

- **Supply chain integrity** — every release is signed and checksummed (SHA256 + cosign keypair + GPG).
- **Secret safety** — API keys live in OS-backed secret storage, never in settings files or logs.
- **Network boundary** — requests only go to URLs you explicitly allow.

See [SECURITY.md](SECURITY.md) for the full threat model and [ADR 0001](docs/adr/0001-security-goals.md) / [ADR 0002](docs/adr/0002-signing-strategy.md).

## 📦 Installation

### From the VS Code Marketplace (recommended)

Open the [Ollama Cloud Provider page](https://marketplace.visualstudio.com/items?itemName=Korrnals.ollama-cloud-provider) and click **Install**. VS Code opens and installs the extension automatically.

Or install from the command line:

```bash
code --install-extension Korrnals.ollama-cloud-provider
```

### From a GitHub Release (signed VSIX)

Download the `.vsix` and checksum file from [Releases](https://github.com/Korrnals/ollama-cloud-provider/releases), verify the SHA256 checksum, and install:

```bash
sha256sum -c sha256.txt
code --install-extension ollama-cloud-provider-*.vsix
```

Releases are signed with cosign (keypair mode) and GPG; see [SECURITY.md](SECURITY.md) and the release notes for signature verification details.

### From source

For developers who want to build locally:

```bash
git clone https://github.com/Korrnals/ollama-cloud-provider.git
cd ollama-cloud-provider
npm ci
npm run compile
npm run package
code --install-extension ollama-cloud-provider-*.vsix
```

## ⚙️ Setup

### 1. Get an API key

Get an Ollama Cloud API key at [ollama.com](https://ollama.com/).

### 2. Configure the extension

Three ways to configure — pick one.

#### Command Palette (recommended)

1. Open the Command Palette: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS).
2. Run `Ollama Cloud: Set API Key`.
3. Enter the key. It is stored in OS-backed secret storage — never written to `settings.json`.
4. Run `Ollama Cloud: Check Connection` to verify the endpoint and discover models.
5. Open Copilot Chat and select an Ollama Cloud model from the picker.

#### Settings UI

1. Open Settings: `Ctrl+,` or `Cmd+,`.
2. Search for `ollamaCloud`.
3. Set `Ollama Cloud: Base Url` — must be in the allowed URLs list.
4. Add the endpoint to `Ollama Cloud: Allowed Base Urls` if not already listed.
5. Prefer `Ollama Cloud: Set API Key` over the `Ollama Cloud: Api Key` setting — the command stores the key in secret storage instead of plaintext.

#### settings.json

```json
{
  "ollamaCloud.baseUrl": "https://ollama.com/v1",
  "ollamaCloud.allowedBaseUrls": ["https://ollama.com/v1"],
  "ollamaCloud.preferredEndpoint": "auto",
  "ollamaCloud.requestMaxDurationMin": 60,
  "ollamaCloud.maxRetries": 3,
  "ollamaCloud.connections": [
    {
      "id": "cloud",
      "label": "Cloud",
      "type": "cloud",
      "enabled": true,
      "baseUrl": "https://ollama.com",
      "openaiCompatiblePath": "/v1",
      "requiresApiKey": true
    }
  ]
}
```

For the API key, use `Ollama Cloud: Set API Key` — it stores the key in secret storage, not in `settings.json`. All settings are `scope: "application"`, so workspace folders cannot override them.

### 3. Verify

Run `Ollama Cloud: Check Connection` to confirm the extension can reach the endpoint and discover models. Then open Copilot Chat and select a model from the picker.

## 🔧 Configuration

| Setting | Default | Description |
|---|---|---|
| `ollamaCloud.apiKey` | `""` | Fallback API key. Prefer `Ollama Cloud: Set API Key` (stores in secret storage). |
| `ollamaCloud.baseUrl` | `https://ollama.com/v1` | API base URL. Must be in `allowedBaseUrls`. |
| `ollamaCloud.allowedBaseUrls` | `["https://ollama.com/v1"]` | Whitelist of permitted base URLs. |
| `ollamaCloud.preferredEndpoint` | `"auto"` | Primary endpoint for cloud/remote. Enum: `"auto"` (default — resolves to `native` (`/api/chat`) for cloud, `chat` (`/chat/completions`) for local; auto-select with 3×404 auto-recovery — switches after 3 consecutive 404s in 5 min, returns to native after 5 min silence), `"native"` (`/api/chat` — ndjson, first-class `think`, object tool args), `"responses"` (`/v1/responses` — structured reasoning, typed events), `"chat"` (`/chat/completions` — classic OpenAI-compatible). Local Ollama always uses `/chat/completions`. Per-connection `preferredEndpoint` overrides this. See [Endpoint routing](#endpoint-routing). |
| `ollamaCloud.requestMaxDurationMin` | `60` | Hard ceiling on total stream duration in **minutes** (1–1440). Single timer (ADR 0012) — protects from forgotten tabs / hung connections. Never reset. No retry. Default 60 min. |
| `ollamaCloud.maxRetries` | `3` | Maximum retries for transient failures (429, 5xx, connect timeout). |
| `ollamaCloud.connections` | `[]` | Multi-connection list. Each entry is a distinct OpenAI-compatible endpoint with its own URL whitelist and API key. When empty, the single-connection settings are used. Each connection can override the global `ollamaCloud.contextFilter.level` via a per-connection `contextFilter.level` (`off`/`safe`/`aggressive` override; `auto` inherits). |
| `ollamaCloud.visionModels` | `[]` | Global vision wildcard patterns. A model id matching any pattern is treated as image-capable. Per-connection `visionModels` override this list. |
| `ollamaCloud.visionFallback.enabled` | `false` | Enable Vision Fallback. Opt-in. |
| `ollamaCloud.visionFallback.model` | `""` | Vision-capable model id for fallback. If empty, auto-searches the primary connection's catalog for the first vision-capable model. |
| `ollamaCloud.visionFallback.connection` | `""` | Connection id for the vision model. If empty, uses the primary connection. |
| `ollamaCloud.visionFallback.mode` | `"two-phase"` | Vision fallback mode (v0.13.0+, ADR 0013): `two-phase` (vision model describes image → primary model answers) or `pass-through` (vision model answers directly). See [Vision fallback](#️-vision-fallback). |
| `ollamaCloud.contextFilter.level` | `"off"` | Context filtering level (ADR 0007): `off` (no filtering), `safe` (structural cleanup — duplicate messages, empty parts, redundant tools, system-prompt whitespace), `aggressive` (safe + context-window truncation + similar-message merging + metadata stripping). See [Context filtering](#context-filtering). Per-connection `contextFilter.level` overrides this global (`auto` inherits). |

All settings are `scope: "application"` — workspace folders cannot override them.

## 🎯 Commands

| Command | Description |
|---|---|
| `Ollama Cloud: Set API Key` | Store the API key in OS-backed secret storage. |
| `Ollama Cloud: Clear API Key` | Remove the stored key. |
| `Ollama Cloud: Switch Endpoint` | Pick an endpoint override (`auto` / `native` / `chat` / `responses`) and update `preferredEndpoint`. Capability cache refreshes immediately; model-picker tooltip follows. |
| `Ollama Cloud: Check Connection` | Probe the configured endpoint. |
| `Ollama Cloud: Validate Configuration` | Validate settings (URL in whitelist, key present). |
| `Ollama Cloud: Set Vision Fallback Model` | Pick a vision-capable model from the catalog. |
| `Ollama Cloud: Set Vision Fallback Connection` | Pick a connection for the vision model (includes a "Clear — use primary connection" option). |
| `Ollama Cloud: Refresh Models` | Force-sync the model catalog with the cloud endpoint, bypassing the 30s cooldown. Shows model count on completion. |
| `Ollama Cloud: Show Registered Models` | List models registered with VS Code. |
| `Ollama Cloud: Show Logs` | Open the extension output channel. |

## 🔄 Model sync

The extension automatically syncs the model catalog from the cloud endpoint:

- **On startup** — the catalog refreshes immediately after activation, so new models (e.g. newly added cloud models) appear without a restart or config change.
- **On config change** — changing `ollamaCloud.baseUrl`, `ollamaCloud.connections`, or `ollamaCloud.allowedBaseUrls` triggers a sync (with a 30s cooldown to avoid spamming).
- **Manual refresh** — run `Ollama Cloud: Refresh Models` to force a sync at any time, bypassing the cooldown. The command shows a progress notification and displays the model count on completion.

## 🔀 Endpoint routing

The extension supports four endpoints, selected by `preferredEndpoint` (default `auto`):

| Value | Path | Wire format | Notes |
|---|---|---|---|
| `auto` | resolves to `native` (cloud) / `chat` (local) / `responses` (vision pass-through) | — | **Setting default.** Auto-select with auto-recovery (see below). |
| `native` | `/api/chat` | Ollama ndjson | First-class `think`, object `tool_calls`, full-event streaming, Ollama metrics. What `auto` resolves to for cloud. |
| `responses` | `/v1/responses` | OpenAI Responses SSE | Structured reasoning (`reasoning_summary_text.delta`), typed events (`response.created` / `response.completed`), first-class tool calling via top-level `function_call` / `function_call_output` items. What `auto` resolves to for vision pass-through. |
| `chat` | `/chat/completions` | OpenAI SSE | Classic OpenAI-compatible. What `auto` resolves to for local. Local Ollama always uses this regardless of the setting. |

Local Ollama connections always use `/chat/completions` regardless of `preferredEndpoint` (local Ollama does not implement `/api/chat` in OpenAI-native form or `/v1/responses`). Vision pass-through always uses `/v1/responses` (`auto`/`native` resolve to `responses` for the vision turn).

### Auto-recovery (3×404 counter)

In `auto` mode, a single native (`/api/chat`) 404 does **not** switch the connection off for the rest of the session. The recovery logic:

- **3 consecutive 404s** within a 5-min sliding window (`shouldAutoSwitch`) → switch to `/chat/completions`.
- **Any success** resets the 404 counter (`reset404s`).
- **After 5 min of silence** the native endpoint is retried (`shouldRetryAfterSilence`), so connections auto-recover without a restart or config change.
- **Stale entries older than 10 min** are pruned (`sweepStaleEntries`, anti-flapping).

The `responses` and `chat` endpoints still mark unavailable on the **first** 404 — they are stable, so a single 404 means truly unsupported. Only `native` uses the 3×404 counter because it is newer and may flap during rollout. The capability cache memoizes 404s per connection, so the fallback path is instant after the first 404.

To override the endpoint manually at any time, run `Ollama Cloud: Switch Endpoint`.

See [ADR 0006](docs/adr/0006-responses-endpoint-primary.md), [ADR 0008](docs/adr/0008-stream-error-handling.md), and [ADR 0009](docs/adr/0009-endpoint-routing.md).

### When to choose which endpoint

| If you want… | Use |
|---|---|
| The documented Ollama Cloud default, self-healing, no tuning | `auto` (default) |
| Native `/api/chat` without auto-recovery | `native` |
| Structured reasoning blocks in Copilot Chat | `responses` |
| Maximum OpenAI-compat compatibility | `chat` |

## ✂️ Context filtering

Long chat sessions and tool-heavy workflows re-send the same trailing context every turn, advertise duplicate tool definitions, and accumulate whitespace the model bills for but ignores. Context filtering is an optional pre-processing step that removes this structural redundancy from the payload **before** it reaches the convert step — lowering token cost while preserving the semantic content of the request and the quality of the response. It removes redundancy only (duplicates, empty parts, whitespace, ignorable metadata); it never removes meaning. All three endpoints — native `/api/chat`, `/v1/responses`, and `/chat/completions` — benefit, because the filter runs at the shared provider entry point before the endpoint-specific convert. See [ADR 0007](docs/adr/0007-context-filtering.md) for the full specification.

### Levels

| Level | What it does | When to use |
|---|---|---|
| `off` (default) | No filtering. Payload sent as-is. Zero overhead. | When you want full fidelity or low traffic. |
| `safe` | Drops duplicate messages (same `role` + identical `content`), empty content parts, and redundant tool definitions (same `function.name`); trims text whitespace; compacts system-prompt whitespace. No message removal, no truncation. | Recommended for most users — pure cleanup, no information loss. |
| `aggressive` | `safe` plus context-window truncation (preserves the system prompt and the last user message), merges similar adjacent messages (same `role`, Jaccard similarity ≥ 0.8), and strips non-essential metadata (`name`, empty `refusal`, unknown keys — never `role`/`content`/`tool_calls`/`tool_call_id`). | Long sessions hitting the model's context limit. |

Estimated token savings (not guarantees; actual savings depend on payload redundancy): `safe` 5–15%, `aggressive` 20–40%. Each request logs its own before/after, so you can verify the saving.

### Quality guarantees

- **Tool-call integrity is binding.** When the filter drops or merges a message carrying a `tool_call`, it always drops the matching `tool_call_output` (and vice versa). A dropped call never leaves an orphaned result; a dropped result never leaves a call with no reply. Multi-turn tool use stays coherent at every level.
- **Vision content is never filtered.** `input_image` parts pass through untouched at every level — silently dropping an image you attached is worse than the token cost.
- **The system prompt and the last user message are always preserved** at `aggressive` truncation. Trimming drops from the front only, after the system prompt.
- **No semantic content is removed** — only structural redundancy: duplicate messages, empty parts, redundant tool definitions, whitespace, and metadata fields the model ignores.

### Configuration

Global setting (see the [Configuration](#configuration) table):

```json
{
  "ollamaCloud.contextFilter.level": "safe"
}
```

Override per connection in `ollamaCloud.connections`. The value `auto` (default) inherits the global setting; `off` / `safe` / `aggressive` override it for that one connection — mirroring the `preferredEndpoint` override/inherit pattern:

```json
{
  "ollamaCloud.contextFilter.level": "safe",
  "ollamaCloud.connections": [
    {
      "id": "cloud",
      "label": "Cloud",
      "type": "cloud",
      "enabled": true,
      "baseUrl": "https://ollama.com",
      "openaiCompatiblePath": "/v1",
      "requiresApiKey": true,
      "contextFilter": {
        "level": "aggressive"
      }
    }
  ]
}
```

### Observability

Each filtered request (at `safe` and `aggressive`; nothing is logged at `off`) writes one line to the extension Output channel (`Ollama Cloud: Show Logs`):

```
Context filter: level=safe before=12345chars after=10500chars saved=15% (3 messages dropped, 0 tools dropped, 0 merged, 0 truncated)
```

`before`/`after` are char-based estimates (the extension has no tokenizer dependency); `saved` is the percentage reduction. The parenthetical field order is `messages dropped, tools dropped, merged, truncated`. Additional one-line diagnostics list each class of action (`dropped N duplicate messages`, `merged N similar pairs`, `truncated N oldest messages`, `dropped N duplicate tools`, `stripped metadata from N fields`), emitted only when that count is non-zero. Orphaned tool outputs (e.g. a tool result whose matching assistant call was dropped) are folded into `messages dropped` and reported under `dropped N duplicate messages`, not as a separate line.

## 👁️ Vision fallback

When the selected model cannot handle images, the extension can automatically use a vision-capable model you configure. The vision model answers for that turn only; the next turn returns to the primary model. Opt-in, with a routing disclosure notification.

To enable:

1. Set `ollamaCloud.visionFallback.enabled` to `true`.
2. Run `Ollama Cloud: Set Vision Fallback Model` to pick a vision-capable model from the catalog.
3. Optionally run `Ollama Cloud: Set Vision Fallback Connection` if the vision model lives on a different connection.
4. Send an image to a non-vision model — the extension swaps to the vision model for that turn and notifies.

### Two-phase vs pass-through (v0.13.0+)

Starting from **v0.13.0**, the vision fallback has two modes, selected by `ollamaCloud.visionFallback.mode`:

| Mode | How it works | When to use |
|---|---|---|
| **`two-phase`** (default, ADR 0013) | Phase 1: vision model describes the image (non-streaming). Phase 2: primary model answers using the text description. | You want the primary model's reasoning style and chain-of-thought preserved. The vision model only translates the image to text. |
| **`pass-through`** (ADR 0004) | The vision model answers directly, streaming its own response to the user. | You want the vision model's answer directly, without the primary model in the loop. |

Two-phase is the default because it preserves the primary model's reasoning style — the vision model only converts the image to a text description, then the primary model produces the final answer using that description. Pass-through remains available for users who want the vision model to answer directly.

See [ADR 0013](docs/adr/0013-two-phase-vision-fallback.md) for the full rationale.

## 🤖 VS Code Agents window

Starting from **v0.9.2**, Ollama Cloud models also appear in the **VS Code Agents window** (Preview) model picker, not only in Copilot Chat.

The extension is not loaded in the Agents window by default. Two settings must be enabled in your `settings.json`:

```jsonc
// settings.json
"extensions.supportAgentsWindow": { "Korrnals.ollama-cloud-provider": true },
"chat.agentHost.byokModels.enabled": true
```

After changing these settings, **restart the Agent Host process** (`Developer: Restart Agent Host` from the Command Palette) — not just Reload Window — so the model metadata is re-read.

> **Default profile required.** The extension must be installed in the default VS Code profile. Extensions installed only in a custom profile are not visible to the Agent Host.

Only models with **tool-calling capability** are eligible for the Agents window picker. Check a model's capabilities via `Ollama Cloud: Show Logs` or the health-check output.

### How it works

The extension sets `isBYOK: true` in the `LanguageModelChatInformation` metadata it returns to VS Code. The Agents window picker only surfaces models where `isBYOK === true`. `isBYOK` is a proposed-API field that flows through at runtime via type augmentation — the same mechanism the extension already uses for `isUserSelectable` and `statusIcon`. No `enabledApiProposals` change is needed.

## 📄 License

MIT — see [LICENSE](LICENSE).
