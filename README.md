<p align="center">
  <img src="media/banner.png" alt="Ollama Cloud Provider" width="100%" />
</p>

# Ollama Cloud Provider

**Security-hardened Ollama Cloud language model provider for VS Code Copilot Chat.**

Ollama Cloud Provider registers Ollama Cloud models as native VS Code language models, making them available in Copilot Chat. It is built with supply-chain hardening, secret-handling safeguards, and reliability features from the ground up.

## Security posture

The extension is designed around three security invariants:

1. **Verifiable supply chain** — every VSIX is signed with Sigstore (keyless) + GPG, with SHA256 checksums and SBOM. Releases are cut locally via `scripts/local-ci/run-release-local.sh` (GitHub Actions CI is disabled due to billing lock, 2026-07-22).
2. **Logger redaction** — `Bearer` tokens, `api_key` patterns, and `data:image/*;base64,...` payloads are masked before any `JSON.stringify`.
3. **baseUrl whitelist** — the extension refuses to send requests to any host not in `ollamaCloud.allowedBaseUrls`.

## Features

- Native VS Code `LanguageModelChatProvider` — Ollama Cloud models appear in Copilot Chat model picker.
- API key stored in OS-backed `SecretStorage` (not plaintext settings).
- `scope: "application"` on all config — workspace `.vscode/settings.json` cannot override keys or redirect traffic.
- Streaming responses with thinking/reasoning support.
- Tool calling (handled by VS Code, not the extension — no `child_process`).
- Multi-connection support — distinct OpenAI-compatible endpoints (Cloud, Local, VPS, custom) with per-connection `allowedBaseUrls` whitelist and API key isolation.
- Health check and configuration validation commands.
- Retry with exponential backoff for transient failures.
- Configurable request timeout.
- **Vision Fallback Pass-through** (ADR 0004) — when the selected model cannot handle image input and the user enables `ollamaCloud.visionFallback`, the extension automatically uses a user-configured vision-capable model for that turn. The vision model answers directly; the next turn returns to the primary model. Opt-in, single-hop, with routing disclosure notification.

## Installation

### From GitHub Release (recommended)

1. Go to [Releases](https://github.com/Korrnals/ollama-cloud-provider/releases).
2. Download the `.vsix` for the latest release.
3. Verify the SHA256 checksum:
   ```bash
   sha256sum -c sha256.txt
   ```
4. Verify the Sigstore signature (optional, requires [cosign](https://github.com/sigstore/cosign)):
   ```bash
   cosign verify-blob --certificate-identity-regexp 'https://github\.com/Korrnals/ollama-cloud-provider/.+' --certificate-oidc-issuer https://token.actions.githubusercontent.com --signature ollama-cloud-provider-*.vsix.sig ollama-cloud-provider-*.vsix
   ```
5. Install:
   ```bash
   code --install-extension ollama-cloud-provider-*.vsix
   ```

### From source

```bash
git clone https://github.com/Korrnals/ollama-cloud-provider.git
cd ollama-cloud-provider
npm ci
npm run compile
npm run package
code --install-extension ollama-cloud-provider-0.5.0.vsix
```

`npm run package` is an alias for `vsce package` (see `package.json` `scripts.package`). It respects `.vscodeignore` and produces `ollama-cloud-provider-<version>.vsix` in the repo root. The current version is `0.5.0`.

### Update from a local VSIX

If you installed from a GitHub Release VSIX or built one locally, update by reinstalling:

```bash
code --install-extension ollama-cloud-provider-0.5.0.vsix --force
```

The `--force` flag overwrites the existing version. Without it, VS Code reports "extension already installed" and skips.

## Setup

### 1. Get an API key

Get an Ollama Cloud API key at [ollama.com](https://ollama.com/).

### 2. Configure the extension — three ways

#### Via Command Palette (recommended for first-time setup)

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS) to open the Command Palette.
2. Run `Ollama Cloud: Set API Key`.
3. Enter your API key. It is stored in OS-backed `SecretStorage` — never written to `settings.json` or workspace files.
4. Run `Ollama Cloud: Check Connection` to verify the extension can reach your endpoint and discover models.
5. Open Copilot Chat and select an Ollama Cloud model from the model picker.

Multi-connection endpoints (Cloud, Local, VPS, custom) are configured via `ollamaCloud.connections` in `settings.json` (see below). Per-connection API keys are stored under separate `SecretStorage` keys (`ollamaCloud.apiKey.<connectionId>`); set them by running `Ollama Cloud: Set API Key` after switching the active connection, or by calling the extension API. The Command Palette flow covers the default Cloud connection end-to-end.

#### Via Settings UI

1. Open Settings (`Ctrl+,` or `Cmd+,`).
2. Search for `ollamaCloud`.
3. Set `Ollama Cloud: Base Url` — must be in the `Allowed Base Urls` whitelist.
4. Set `Ollama Cloud: Allowed Base Urls` — add your endpoint if not already listed.
5. Note: the `Ollama Cloud: Api Key` setting is a fallback only. Prefer the Command Palette (`Ollama Cloud: Set API Key`), which stores the key in `SecretStorage` instead of plaintext settings.

#### Via settings.json

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

For the API key, still use the Command Palette (`Ollama Cloud: Set API Key`) — it stores the key in `SecretStorage`, not in `settings.json`. All settings are `scope: "application"`, so workspace folders cannot override them.

### 3. Enable Vision Fallback (optional)

If you want the extension to automatically use a vision-capable model when the selected model cannot handle images:

1. Set `ollamaCloud.visionFallback.enabled` to `true`.
2. Run `Ollama Cloud: Set Vision Fallback Model` to pick a vision-capable model from the catalog (QuickPick).
3. Optionally run `Ollama Cloud: Set Vision Fallback Connection` if the vision model lives on a different connection.
4. When you send an image to a non-vision model, the extension swaps to the vision model for that turn and notifies you.

### 4. Verify

Run `Ollama Cloud: Check Connection` to confirm the extension can reach your endpoint and discover models. Then open Copilot Chat and select a model from the picker.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `ollamaCloud.apiKey` | `""` | Fallback API key. Prefer the command palette (stores in SecretStorage). |
| `ollamaCloud.baseUrl` | `https://ollama.com/v1` | API base URL. Must be in `allowedBaseUrls`. |
| `ollamaCloud.allowedBaseUrls` | `["https://ollama.com/v1"]` | Whitelist of permitted base URLs. |
| `ollamaCloud.requestTimeoutMs` | `120000` | Request timeout in ms. |
| `ollamaCloud.maxRetries` | `3` | Max retries for transient failures (429, 5xx). |
| `ollamaCloud.connections` | `[]` | Multi-connection list. Each entry is a distinct OpenAI-compatible endpoint with its own `allowedBaseUrls` whitelist and API key. When empty, the legacy single-connection settings are used. |
| `ollamaCloud.visionModels` | `[]` | Global vision wildcard patterns. A model id matching any pattern is treated as image-capable. Per-connection `visionModels` override this list. |
| `ollamaCloud.visionFallback.enabled` | `false` | Enable Vision Fallback Pass-through (ADR 0004). Opt-in. |
| `ollamaCloud.visionFallback.model` | `""` | Vision-capable model id for fallback. If empty, auto-searches the primary connection's catalog for the first vision-capable model. |
| `ollamaCloud.visionFallback.connection` | `""` | Connection id for the vision model. If empty, uses the primary connection. |

All settings are `scope: "application"` — workspace folders cannot override them.

## Commands

- `Ollama Cloud: Set API Key` — store the API key in OS-backed SecretStorage.
- `Ollama Cloud: Clear API Key` — remove the stored key.
- `Ollama Cloud: Show Registered Models` — list models registered with VS Code.
- `Ollama Cloud: Show Logs` — open the extension output channel.
- `Ollama Cloud: Check Connection` — probe the configured endpoint.
- `Ollama Cloud: Validate Configuration` — validate settings (baseUrl in whitelist, key present).
- `Ollama Cloud: Set Vision Fallback Model` — QuickPick from vision-capable models in the catalog.
- `Ollama Cloud: Set Vision Fallback Connection` — QuickPick from configured connections (includes a "Clear — use primary connection" option).

## Architecture decisions

This extension follows a set of recorded architectural decisions:

- [ADR 0001 — Security goals and non-goals](docs/adr/0001-security-goals.md)
- [ADR 0002 — Signing strategy](docs/adr/0002-signing-strategy.md)
- [ADR 0003 — Native provider UX](docs/adr/0003-native-provider-ux.md)
- [ADR 0004 — Vision Fallback Pass-through](docs/adr/0004-vision-fallback-pass-through.md)

## CI

CI runs locally via `scripts/local-ci/` — see [DEVELOPMENT.md](DEVELOPMENT.md). External GitHub Actions CI is disabled due to billing lock (2026-07-22); re-enable when billing is resolved.

## Security

See [SECURITY.md](SECURITY.md) for the security policy and responsible disclosure.

## License

MIT — see [LICENSE](LICENSE).
