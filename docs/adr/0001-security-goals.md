# ADR-0001: Security goals and non-goals

**Date:** 2026-07-16
**Status:** Accepted

## Context

The extension is a `LanguageModelChatProvider` implementation that registers Ollama Cloud models in Copilot Chat. The initial security review (2026-07-16) set the scope and the invariants the extension must maintain:

1. **SEC-01 (High):** Verifiable supply chain — VSIX releases must be built in CI, signed, and checksummed so users can prove the installed VSIX matches the reviewed source.
2. **SEC-02 (Medium):** Logger redaction — `JSON.stringify(detail)` must never emit secrets; the redaction layer must be structural, not caller-dependent.
3. **SEC-03 (Medium):** baseUrl restrictions — the API key must never be sent to a host outside the user-configured `allowedBaseUrls` whitelist.

A separate extension, JKagiDesigns "Ollama Cloud", was also audited and rejected — it has a 10× larger attack surface (command execution, file editing, webview, URI handler), plaintext API key storage, and its GitLab repository is scheduled for deletion on 2026-07-23. The rejected surface area informs the non-goals below.

## Decision

Build a minimal, security-hardened `LanguageModelChatProvider`. The extension:

- Keeps the minimal architecture: `LanguageModelChatProvider` API, no webview, no `child_process`, no URI handler, no context-file ingestion.
- Adds security hardening (logger redaction, baseUrl whitelist, scope verification).
- Adds supply-chain hardening (CI-built VSIX, Sigstore + GPG signing, SHA256, SBOM).
- Adds reliability features (retry with exponential backoff, configurable timeout).
- Adds UX features (health check, configuration validation, smart notification for missing API key).

## Non-goals

The following features are explicitly **rejected** as they introduce attack surface disproportionate to their value:

- **Multi-provider support** (OpenAI, Anthropic, Grok) — out of scope; this extension is Ollama Cloud only.
- **ACT mode** (file editing, command execution) — this is the RCE surface rejected in the JKagiDesigns audit. The extension remains a pure language model provider.
- **Webview chat UI** — `LanguageModelChatProvider` already provides UI via Copilot Chat; a custom webview adds CSP and model-controlled-HTML risks.
- **URI handler** — webpages should not be able to trigger extension actions.
- **Context-file ingestion** — workspace files are prompt-injection vectors; the extension does not read `.ollamacloud.md` or similar files.
- **Autocomplete** — proactive file-content sending increases exfiltration surface.
- **Telemetry / analytics** — no phone-home, no usage reporting.

## Consequences

- **Positive:** The extension remains auditable (~10 source files, zero runtime dependencies). Attack surface is minimal. Supply chain is verifiable.
- **Negative:** Users who want ACT mode, multi-provider, or autocomplete must use a different extension. This is acceptable — the goal is a guaranteed-safe provider, not a feature-complete agent.