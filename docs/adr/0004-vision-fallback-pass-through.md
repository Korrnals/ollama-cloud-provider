# ADR-0004: Vision Fallback Pass-through for non-vision primary models

**Date:** 2026-07-22
**Status:** Accepted

## Deciders

- `@GCW: Tech Lead` (chair, engineering owner)
- `@GCW: Product Architect`
- `@GCW: Senior Security Engineer`
- `@GCW: Senior System Engineer`
- Owner (Korrnals) — final decision authority

## Context

The extension is a security-hardened `LanguageModelChatProvider` for Ollama Cloud (ADR 0001). ADR 0001 records the non-goal "the extension does not decide for the user" — but that non-goal concerns *rejecting agent features* (ACT mode, context-file ingestion, autocomplete), not *routing within the provider*. Vision routing is a provider-internal concern, consistent with ADR 0001's security invariants (SEC-01/02/03) and ADR 0003's native-provider UX.

As of v0.4.0, the extension:

- Infers vision capability per model (image-input detection).
- Handles images in chat messages.
- Supports multiple connections (`ConnectionConfig` in `connections.ts`), each with its own SEC-03 `allowedBaseUrls` whitelist and API key.

**Current behavior** when the user sends an image to a text-only (non-vision) primary model: `provider.ts` vision gate throws (lines ~226-235). The user must manually switch to a vision-capable model. The owner wants automatic routing to a vision-capable model **without** manual model switch — the user keeps their preferred primary model for text, and vision is handled transparently when an image arrives.

**References studied:**

- **Hermes `Bamboomuntu/hermes-cu-vision-fallback`** — implements alternative A (two-stage subagent: DeepSeek primary + Gemini Flash auxiliary). Uses a filesystem flag for an approval gate (1h expiry), SHA256 cache, and a fixed screenshot-UI prompt. We do **not** adopt: filesystem flag (use a VS Code setting), screenshot-only prompt (we handle arbitrary images), or the subagent pattern (owner chose B pass-through).
- **Hermes `dripowner/hermes-ollama-vision-proxy`** — a format-translation proxy (OpenAI multimodal → Ollama native `/api/chat`). Not agent logic; not relevant to this design.
- **Noizboy** — current release has **no** vision fallback (returns error on image-to-text-only-model, which equals our current behavior D). `ORCHESTRATOR_PLAN.md` describes a multi-hop agent (analyzer → planner → implementer → reviewer). This ADR explicitly **rejects** the multi-hop pattern (see "Alternatives considered" and Constraint 10).

## Decision

Implement **Vision Fallback Pass-through (alternative B)**: when the primary model cannot handle an image and the user has enabled fallback, the extension swaps to a user-configured vision-capable model for **that single turn**. The vision model answers the user directly. The primary model is not involved in that turn; the next turn returns to the primary model.

### Binding constraints (10)

These constraints are part of the decision. Any implementation that violates one of them does not implement this ADR.

1. **Single-hop.** One vision call per turn. No multi-hop, no tool loop, no phase orchestration. Multi-hop = new ArchCom + new ADR. (Product Architect condition; explicitly rejects the Noizboy `ORCHESTRATOR_PLAN.md` multi-phase agent pattern.)

2. **Opt-in, default off.** Setting `ollamaCloud.visionFallback.enabled` (boolean, `scope: application`, default `false`). The user must explicitly enable fallback.

3. **Vision model — two paths, both required.**
   - Setting `ollamaCloud.visionFallback.model` (string, `scope: application`) — manual entry of a model id (safe fallback if QuickPick is empty).
   - Command `Ollama Cloud: Set Vision Fallback Model` — QuickPick from vision-capable models in the catalog (`modelCatalog.ts` already filters by `capabilities.imageInput`). Saves the selection to the setting.

4. **Vision connection — optional, default primary.** Setting `ollamaCloud.visionFallback.connection` (string, `scope: application`, optional). If not set, the extension uses the primary connection (where the primary model lives). If the primary connection has no vision models, the user can set a cross-connection (e.g., primary on Local, vision on Cloud). Optional command `Ollama Cloud: Set Vision Fallback Connection` — QuickPick from configured connections.

5. **Auto-search when model not set.** If `visionFallback.model` is not set, the extension searches the primary connection's catalog for the first vision-capable model. If found, it is used. If not found, the extension returns an error to the user ("no vision model found, configure `ollamaCloud.visionFallback.model`").

6. **Vision endpoint = `ConnectionConfig`.** The vision endpoint MUST be a configured connection (the existing `ConnectionConfig` from `connections.ts`). NOT a standalone URL. This is load-bearing for SEC-03 per-connection `allowedBaseUrls` whitelist and per-connection key isolation. No bypass.

7. **Hardcoded prompt.** The vision prompt is hardcoded in source, NOT a setting. Reason: a configurable prompt through settings is a prompt-injection channel (Senior Security Engineer blocker #2). The user cannot override it via `ollamaCloud.visionFallback.prompt`. Approximate prompt text (final wording in implementation): *"Describe this image in detail — text, layout, visible elements — so another model can answer a question about it."*

   **Clarification for B (pass-through).** In pure pass-through the user's original message + image goes to the vision model **unchanged** — no intermediate prompt is sent to a subagent, because there is no subagent. The "hardcoded prompt" constraint applies if any prompt is sent (e.g., a future variant); in this ADR's pass-through path the user message + image is forwarded as-is.

8. **Routing disclosure notification.** When fallback fires, show a notification: *"Vision fallback: answered by `<vision model>` (primary `<primary model>` could not handle image)."* Not silent. Data-residency disclosure: if the vision connection differs from the primary, the notification adds *"(via `<vision connection name>`)"*.

9. **No silent degradation.** If fallback is disabled and the primary cannot handle vision, the current behavior is preserved (throw, `provider.ts:226-235`). No silent text-only fallback.

10. **Single-hop contract boundary.** This ADR explicitly rejects multi-hop agent orchestration (the Noizboy `ORCHESTRATOR_PLAN.md` pattern: analyzer → planner → implementer → reviewer). Single vision call only. Any multi-hop feature requires a new ArchCom + new ADR.

### Security invariants (must hold on implementation — verify before merge)

- **SEC-03** per-connection `allowedBaseUrls` whitelist (fail-closed at the fetch boundary) — the vision fetch goes through `OllamaClient` with the vision connection's whitelist.
- **Per-connection key isolation** — the vision connection's key is used only for the vision fetch, never mixed with the primary.
- **SEC-02** `redactSensitive` (7 patterns including base64 image) — covers any log of vision fallback.
- `scope: application` on all new settings — workspace folders cannot override them.
- No `child_process` / `eval` / `webview` / `telemetry` — the 9 CI gates enforce this.
- Zero new runtime dependencies.

## Consequences

### Positive

- The user does not switch models manually — the primary model stays for text, vision is handled transparently when an image arrives.
- Simpler than alternative A (one call vs two; no `chatCompletion` non-streaming variant, no message rewrite, no cache, no assistant-role wrapper).
- Structurally safer than A — the vision model's output goes to the user, not into the primary model's context, so there is no indirect prompt-injection surface and no assistant-role wrapper is required. (Senior Security Engineer's reasoning.)
- Preserves ADR 0001 security posture: vision endpoint is a `ConnectionConfig` (SEC-03 whitelist + key isolation), redaction covers image logs, `scope: application` blocks workspace-folder override, 9 CI gates unchanged, zero new dependencies.

### Negative

- The vision model answers directly — it may be weaker at reasoning than the primary model. The owner accepts this: for Copilot Chat with arbitrary images, the vision model answering the vision question directly is the desired UX.
- The image is sent to the vision endpoint — disclosed in the notification; same surface as the current vision-capable model path (no new exfiltration surface).
- Vision provider data residency may differ from the primary — disclosed in the notification (`(via <vision connection name>)` when the vision connection differs).

### Neutral

- Single-hop contract — any multi-hop agent feature requires a new ArchCom + new ADR. This ADR does not set a precedent for multi-hop.

## Alternatives considered

| Alternative | Description | Reason accepted / rejected |
|---|---|---|
| **A — Two-stage relay** | Primary model calls a vision model as a subagent, processes the vision output, and formulates the final answer. Two calls; requires a `chatCompletion` non-streaming variant, message rewrite, and an assistant-role wrapper to defend against indirect prompt injection. | **Rejected by owner after trade-off.** Structurally less safe (indirect injection surface closed by wrapper, but the surface exists), more complex (~500 lines, complexity M) with no UX gain for Copilot Chat with arbitrary images. The Product Architect recommended A for answer consistency with the primary model, but the owner chose B after seeing the trade-off. Recorded here for future revisiting. |
| **B — Pass-through** (chosen) | One vision call; vision model answers the user directly; primary model not involved in that turn. | **Accepted.** Matches the owner's goal (no manual switch), structurally safer (no injection surface), simpler (~350 lines, S-M). |
| **C — Manual switch prompt** | Extension prompts the user to switch to a vision-capable model manually. | **Rejected.** Defeats the goal "the user does not switch models manually". |
| **D — Reject** (current behavior) | `throw` on image-to-text-only-model (`provider.ts:226-235`). | **Rejected.** Current behavior; the owner wants the feature. Preserved only when fallback is disabled (Constraint 9 — no silent degradation). |
| **Multi-hop agent** (Noizboy `ORCHESTRATOR_PLAN.md`) | analyzer → planner → implementer → reviewer phases. | **Rejected** by Constraint 10. Multi-hop requires a new ArchCom + new ADR. |

### Configurable vision prompt — three-way split and resolution

The committee split three ways on whether the vision prompt should be configurable:

| Position | Holder | Proposal | Outcome |
|---|---|---|---|
| Fixed prompt | Product Architect | Hardcoded or via `modelConfiguration.ts` (not a setting) | Folded into the hardcoded decision |
| Hardcoded (blocker) | Senior Security Engineer | Hardcoded in source; configurable prompt = injection channel (blocker #2) | **Adopted** — Constraint 7 |
| Configurable with default | Senior System Engineer | Setting with a safe default; user override | Rejected — injection risk outweighs convenience |

**Resolution:** the chair decided in favor of the Senior Security Engineer — the prompt is hardcoded in source (Constraint 7). The owner confirmed.

### Senior Security Engineer note on B vs A

The Senior Security Engineer flagged B as **structurally safer** than A: in B the vision model's output goes to the user, not into the primary model's context, so there is no indirect prompt-injection surface and no assistant-role wrapper is required. A is technically defensible (wrapper + hardcoded prompt) but adds attack surface without a corresponding benefit. The owner aligned with the SSE's safety reasoning when choosing B.

## References

- ADR 0001 — `docs/adr/0001-security-goals.md` — security goals (SEC-01/02/03) and the non-goal "the extension does not decide for the user" (concerns agent features, not provider-internal routing).
- ADR 0003 — `docs/adr/0003-native-provider-ux.md` — native `LanguageModelChatProvider` UX.
- Architectural Committee protocol — `~/.gcw/architectural-committee/2026-07-22-vision-fallback-pass-through.md` (team-local, not committed).
- Architectural Committee contract — `~/.gcw/architectural-committee/2026-07-22-vision-fallback-pass-through-contract.md` (team-local, not committed).
- Mnemos decision entry — `1fa77b56-e6a2-4b85-8bcc-8307bfe31efb` (tags: `project:ollama-cloud-provider`, `agent:gcw-tech-lead`, `mnemos:decision`, `committee`).
- Hermes `Bamboomuntu/hermes-cu-vision-fallback` — https://github.com/Bamboomuntu/hermes-cu-vision-fallback (alternative A reference; not adopted).
- Hermes `dripowner/hermes-ollama-vision-proxy` — https://github.com/dripowner/hermes-ollama-vision-proxy (format-translation proxy; not relevant).
- Noizboy `ORCHESTRATOR_PLAN.md` — multi-hop agent pattern explicitly rejected by Constraint 10.