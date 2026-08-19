# ADR 0013 — Two-Phase Vision Fallback (Primary Path)

**Date:** 2026-08-19
**Status:** Accepted
**Supersedes:** ADR 0004 (pass-through demoted to fallback)

## Context

ADR 0004 defined a single-hop vision fallback (pass-through): when a
text-only primary model receives an image, the request is routed
entirely to a vision-capable model, which answers the user directly.

Two problems with pass-through:

1. **Primary model reasoning lost.** The user's chosen primary model
   (e.g. `glm-5.2`, `gpt-oss:20b`) is bypassed for the vision turn. The
   vision model's reasoning is weaker than the primary's; the user
   loses the model they chose.
2. **ECONNRESET on vision stream.** The vision model (e.g.
   `minimax-m3`) on `/v1/responses` drops the stream after 557–918
   chunks, surfacing a mid-stream error to the user.

## Decision

**Two-phase vision is the DEFAULT path; pass-through is the fallback.**

### Two-phase flow

1. **Phase 1 (vision describe):** the vision model receives the image
   + a hardcoded describe prompt → returns a text description of the
   image (non-streaming, `nativeChatOnce`).
2. **Phase 2 (primary answer):** the primary model receives the text
   description (replacing the image part) + the original user question
   → answers normally via the provider's existing endpoint dispatch.

### Why two-phase is the default

- **Primary reasoning preserved.** The user's chosen model answers the
  question, using the vision model only as an image-to-text bridge.
- **ECONNRESET mitigation.** Phase 1 is a non-streaming one-shot call
  (no long stream to drop). Phase 2 uses the primary's stream, which
  is stable for text-only responses.
- **Indirect prompt-injection defence.** The vision model's
  description is wrapped in a delimiter
  (`[Image description from <visionModel>: ...]`) that marks it as
  model-generated image content, not user instruction.

### Pass-through remains available

`ollamaCloud.visionFallback.mode: 'pass-through'` opts into the
ADR 0004 single-hop path. Use cases: when the vision model's direct
answer is preferred, or for debugging the two-phase path.

## Security invariants (preserved from ADR 0004)

- **SEC-03 per-connection `allowedBaseUrls` whitelist** — the vision
  fetch goes through `OllamaClient.nativeChatOnce` with the vision
  connection's whitelist.
- **Per-connection key isolation** — the vision connection's key is
  used only for the vision fetch.
- **Image data URLs NEVER logged** — only the SHA-256 short hash of
  the first image part is logged for correlation (same pattern as
  pass-through).
- **Hardcoded describe prompt** — `VISION_DESCRIBE_PROMPT` is a
  constant, not a setting. A configurable prompt is a
  prompt-injection channel (ADR 0004 constraint 7).

## Residual risks

| Risk | Mitigation | Accepted? |
| --- | --- | --- |
| Vision model emits injected instructions in description | Delimiter wrapping marks content as model-generated, not user instruction | Partial — full assistant-role-wrapper is ArchCom follow-up |
| Vision model call times out | 90s timeout + CancellationToken propagation; user sees clear error, not silent degradation | Yes |
| Phase 2 primary stream still drops (text-only ECONNRESET) | Out of scope — primary stream stability is a separate issue | Yes |

## Setting

```json
{
  "ollamaCloud.visionFallback.mode": {
    "enum": ["two-phase", "pass-through"],
    "default": "two-phase"
  }
}
```

## References

- ADR 0004 — vision fallback pass-through (now the fallback path)
- ADR 0007 — context filtering (image data URLs in history)
- `src/visionTwoPhase.ts` — implementation
- `src/visionFallback.ts` — pass-through fallback (`executePassThrough`)
- Owner directive 2026-08-19: «реализовываем двухфазный визуал, как
  основной, и однофазный как резервный»