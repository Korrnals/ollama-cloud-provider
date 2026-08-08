# Open issue draft — microsoft/vscode

> **Status:** Draft — not yet filed. Owner decides when/whether to file against
> https://github.com/microsoft/vscode/issues.
>
> **Source:** Researcher investigation (mnemos id `2b666ff7`, 2026-08-08)
> confirmed the root cause by reading VS Code source. This draft is produced by
> the `ollama-cloud-provider` maintainers (v0.9.2) who hit the gap in production.
>
> **How to file:** copy everything below the `---` cut line into a new GitHub
> issue. Fill the version placeholder before filing.

---

# Extension `LanguageModelChatProvider` models cannot appear in Agents window picker — `isBYOK` is proposed-only

**Labels suggestion:** `agents-window`, `api-proposal`, `chat`

## Environment

- **VS Code version:** `(owner fills: Help → About → copy version)`
- **Extension:** `Korrnals.ollama-cloud-provider` v0.9.2
  - Registers models via the **stable** `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` API
  - Declares the `languageModelChatProviders` contribution point
  - No `enabledApiProposals` entry — uses stable API only

## Repro steps

1. Install a third-party extension that registers models via the stable `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` API and the `languageModelChatProviders` contribution point.
2. In user settings, enable the extension in the Agents window and turn on BYOK models:

   ```jsonc
   "extensions.supportAgentsWindow": { "<publisher.extension-id>": true },
   "chat.agentHost.byokModels.enabled": true
   ```

3. Restart the Agent Host process.
4. Open the **Agents** window (Preview). Open the model picker in a Copilot agent session.

## Expected

The extension's models are selectable in the Agents window model picker. BYOK (bring-your-own-key) models are documented as usable in Agent Host sessions once `chat.agentHost.byokModels.enabled` is on.

## Actual

Only **Auto** and **Copilot** models are selectable in the Agents window picker. The extension's models appear in the Language Models editor (`@builtin` / "Language Models") but are **not** surfaced in the Agents window picker.

## Root cause

The Agents window picker filters its model list on the `isBYOK` metadata field. The filter lives in the Agent Host BYOK handler:

```ts
// src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostByokLmHandler.ts
// AgentHostByokLmHandler.listModels() filters on:
//   metadata?.isBYOK === true
```

`isBYOK` is defined **only** in the proposed API:

```
src/vscode-dts/vscode.proposed.chatProvider.d.ts
```

The **stable** `LanguageModelChatInformation` type (`@types/vscode@1.125.0`) has **no** `isBYOK` field. A third-party extension using the stable `vscode.lm.registerLanguageModelChatProvider` API therefore has no supported way to mark its models as Agent-Host-eligible — the `isBYOK` flag cannot be set through the stable type.

Built-in BYOK providers (Anthropic, OpenAI, Gemini, xAI, Azure, Custom Endpoint, and the built-in Ollama integration) set `isBYOK` internally via the proposed API and so pass the filter. Third-party providers using the stable API cannot.

## Request

Promote Agent Host model eligibility to the stable API surface so third-party `LanguageModelChatProvider` extensions can participate without workarounds. Either:

**(a)** Promote `isBYOK: boolean` to the stable `LanguageModelChatInformation` type, so a provider can return `isBYOK: true` from `provideLanguageModelChatInformation` and have its models surface in the Agents window picker.

**(b)** Document an alternative opt-in that does not require a proposed-only field — e.g.:
- a `languageModelChatProviders` contribution-point property (`"agentHostEligible": true`), or
- auto-bridging all `languageModelChatProviders`-contributed models into the Agent Host picker when `chat.agentHost.byokModels.enabled` is on.

Option (a) is the smallest change and mirrors how built-in providers already behave. Option (b) avoids a new stable field but shifts the opt-in to the contribution manifest.

## Workaround (what third-party extensions do today)

Type augmentation that adds `isBYOK?: boolean` to a local `LanguageModelChatInformation` extension type, then sets `isBYOK: true` on the object returned from `provideLanguageModelChatInformation`. The value flows through at runtime — the stable API does not validate unknown fields, so `isBYOK` reaches `AgentHostByokLmHandler.listModels()` and passes the filter.

```ts
// Type augmentation (extension-local) — no enabledApiProposals needed
type ModelPickerInformation = vscode.LanguageModelChatInformation & {
  isBYOK?: boolean;
  // ... other augmented fields
};

// In provideLanguageModelChatInformation:
return {
  // ...standard fields...
  isBYOK: true,
} as ModelPickerInformation;
```

This is **undocumented and fragile**: it relies on the stable API not rejecting unknown fields at runtime, and it could regress if type checks are tightened or the proposed-API field is renamed/removed. A supported stable path (per the request above) would remove this risk.

## Context

- Source investigation confirmed the filter and the proposed-only definition of `isBYOK` (mnemos reference, 2026-08-08).
- No existing GitHub issue found for this gap as of 2026-08-08.
- The `ollama-cloud-provider` extension (Korrnals) ships this workaround in v0.9.2; other third-party `LanguageModelChatProvider` extensions using the stable API will hit the same wall.
