<p align="center">
  <img src="media/banner.png" alt="Ollama Cloud Provider" width="100%" />
</p>

[![Version](https://img.shields.io/visual-studio-marketplace/v/Korrnals.ollama-cloud-provider?style=flat-square&label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=Korrnals.ollama-cloud-provider)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Korrnals.ollama-cloud-provider?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=Korrnals.ollama-cloud-provider)

# Ollama Cloud Provider

**Use Ollama Cloud models in VS Code Copilot Chat.**

## Overview

Ollama Cloud Provider registers Ollama Cloud models as native VS Code language models, making them available in the Copilot Chat model picker. Configure an API key, select a model, and chat — no wrappers, no extra UI, no separate chat window.

The extension is built for reliability and safety: API keys live in OS-backed secret storage, requests only go to URLs you explicitly allow, and every release is signed and checksummed.

## Key features

- **Native Copilot Chat integration** — Ollama Cloud models appear in the Copilot Chat model picker as first-class VS Code language models.
- **Secret storage** — API keys are stored in the OS-backed secret store, never in `settings.json` or workspace files.
- **Streaming responses** — token streaming with reasoning/thinking support.
- **Tool calling** — handled natively by VS Code, with no shell execution from the extension.
- **Multi-connection** — connect to several OpenAI-compatible endpoints (Cloud, Local, VPS, custom) with per-connection API keys and URL whitelists.
- **Retry and timeout** — exponential backoff for transient failures, configurable request timeout.
- **Health check** — probe the endpoint and discover models before chatting.
- **Configuration validation** — catch misconfiguration (missing key, URL not whitelisted) before it breaks a chat.

## Security posture

Security is a first-class concern:

- **Supply chain integrity** — every release is signed and checksummed.
- **Secret safety** — API keys live in OS-backed secret storage, never in settings files or logs.
- **Network boundary** — requests only go to URLs you explicitly allow.

## Installation

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

Releases are signed; see the release notes for signature verification details.

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

## Setup

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
  "ollamaCloud.requestTimeoutMs": 120000,
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

## Configuration

| Setting | Default | Description |
|---|---|---|
| `ollamaCloud.apiKey` | `""` | Fallback API key. Prefer `Ollama Cloud: Set API Key` (stores in secret storage). |
| `ollamaCloud.baseUrl` | `https://ollama.com/v1` | API base URL. Must be in `allowedBaseUrls`. |
| `ollamaCloud.allowedBaseUrls` | `["https://ollama.com/v1"]` | Whitelist of permitted base URLs. |
| `ollamaCloud.requestTimeoutMs` | `120000` | Request timeout, in milliseconds. |
| `ollamaCloud.maxRetries` | `3` | Maximum retries for transient failures (429, 5xx). |
| `ollamaCloud.connections` | `[]` | Multi-connection list. Each entry is a distinct OpenAI-compatible endpoint with its own URL whitelist and API key. When empty, the single-connection settings are used. |
| `ollamaCloud.visionModels` | `[]` | Global vision wildcard patterns. A model id matching any pattern is treated as image-capable. Per-connection `visionModels` override this list. |
| `ollamaCloud.visionFallback.enabled` | `false` | Enable Vision Fallback. Opt-in. |
| `ollamaCloud.visionFallback.model` | `""` | Vision-capable model id for fallback. If empty, auto-searches the primary connection's catalog for the first vision-capable model. |
| `ollamaCloud.visionFallback.connection` | `""` | Connection id for the vision model. If empty, uses the primary connection. |

All settings are `scope: "application"` — workspace folders cannot override them.

## Commands

| Command | Description |
|---|---|
| `Ollama Cloud: Set API Key` | Store the API key in OS-backed secret storage. |
| `Ollama Cloud: Clear API Key` | Remove the stored key. |
| `Ollama Cloud: Check Connection` | Probe the configured endpoint. |
| `Ollama Cloud: Validate Configuration` | Validate settings (URL in whitelist, key present). |
| `Ollama Cloud: Set Vision Fallback Model` | Pick a vision-capable model from the catalog. |
| `Ollama Cloud: Set Vision Fallback Connection` | Pick a connection for the vision model (includes a "Clear — use primary connection" option). |
| `Ollama Cloud: Show Registered Models` | List models registered with VS Code. |
| `Ollama Cloud: Show Logs` | Open the extension output channel. |

## Vision Fallback

When the selected model cannot handle images, the extension can automatically use a vision-capable model you configure. The vision model answers for that turn only; the next turn returns to the primary model. Opt-in, with a routing disclosure notification.

To enable:

1. Set `ollamaCloud.visionFallback.enabled` to `true`.
2. Run `Ollama Cloud: Set Vision Fallback Model` to pick a vision-capable model from the catalog.
3. Optionally run `Ollama Cloud: Set Vision Fallback Connection` if the vision model lives on a different connection.
4. Send an image to a non-vision model — the extension swaps to the vision model for that turn and notifies.

## License

MIT — see [LICENSE](LICENSE).
