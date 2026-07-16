# ADR-0003: Native provider UX and API key entry

**Date:** 2026-07-16
**Status:** Accepted

## Context

The upstream extension uses `vscode.LanguageModelChatProvider` — the native VS Code API for registering language models. Ollama Cloud models already appear in the Copilot Chat model picker with `displayName: "Ollama Cloud"`.

However, VS Code does not support inline API key entry in the model picker for third-party providers. The upstream extension requires the user to find and run `Ollama Cloud: Set API Key` from the command palette — a discoverability gap.

## Decision

Implement a **smart notification** approach for v0.2.0:

1. When the user selects an Ollama Cloud model in Copilot Chat and no API key is configured, the extension shows an information notification: "Ollama Cloud API key required. Set it now?" with a "Set API Key" button.
2. Clicking the button opens the `promptForApiKey()` input box (password field, stored in SecretStorage).
3. After the key is set, the model becomes usable immediately (the `onDidChangeLanguageModelChatInformation` event fires).

## Rejected alternatives

- **Inline token entry in model picker** — not possible for third-party providers; VS Code does not expose this API.
- **`AuthenticationProvider` API** — adds ~150 lines and more API surface. The Accounts menu "Sign In" flow is nice but overkill for a single-key provider. Deferred to v0.3.0 if user demand warrants it.

## Consequences

- **Positive:** ~20 lines of code, zero attack surface, significantly better discoverability than command-palette-only.
- **Positive:** The extension remains a pure `LanguageModelChatProvider` — no `AuthenticationProvider` registration, no additional VS Code API surface.
- **Neutral:** The notification appears only when a model is selected without a key. Users who never select an Ollama Cloud model never see it.
