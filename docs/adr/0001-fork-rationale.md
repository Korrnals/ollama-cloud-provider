# ADR-0001: Fork rationale and security goals

**Date:** 2026-07-16
**Status:** Accepted

## Context

The upstream extension [Ollama-Cloud-for-Copilot](https://github.com/zelosleone/Ollama-Cloud-for-Copilot) by Denizhan Dakılır is a clean, minimal `LanguageModelChatProvider` implementation. A security audit (2026-07-16) found the code safe but identified three unresolved concerns:

1. **SEC-01 (High):** Unverifiable supply chain — single-author Marketplace VSIX, no CI, no signed releases, no SBOM. Cannot prove the published VSIX matches the reviewed source.
2. **SEC-02 (Medium):** Logger without redaction — `JSON.stringify(detail)` called unconditionally; no structural guarantee that future commits won't log sensitive data.
3. **SEC-03 (Medium):** No baseUrl restrictions — API key sent to whatever host the user configures, including untrusted hosts.

A separate extension, JKagiDesigns "Ollama Cloud", was also audited and rejected — it has a 10× larger attack surface (command execution, file editing, webview, URI handler), plaintext API key storage, and its GitLab repository is scheduled for deletion on 2026-07-23.

## Decision

Fork the upstream extension and harden it. The fork:

- Preserves the MIT license and attribution to the original author.
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
- **Neutral:** The fork must track upstream for model-catalog updates and API changes, re-auditing security-critical files on each merge.
