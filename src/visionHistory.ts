/**
 * ADR 0013 lifecycle extension (2026-09-15) — image resend inflation
 * on the NATIVE vision path. Extended the same day by ArchCom
 * 2026-09-15 "unified vision descriptions" (variant (b)): the
 * marker lifecycle is now the fallback for EVERY degradation, and
 * `visionHistory.mode` selects between describe-unification and the
 * raw-first-send path — see the mode semantics below.
 *
 * RCA (mnemos 1731bef7): VS Code re-sends the full immutable history
 * on every turn, images included. One screenshot ≈ 1.9–2.0M chars
 * of base64 PER TURN: the owner's session grew to requestChars=2.46M,
 * the harness carried those megabytes into subagent delegations, and
 * the delegations died on context overflow (D408 "no output") before
 * their first model request.
 *
 * Lifecycle contract (symmetric to the two-phase marker rule):
 *   - FIRST send of an image (by content hash) in a window/session:
 *     forwarded RAW — the model truly sees it. No quality loss on the
 *     turn that matters.
 *   - EVERY subsequent send of the SAME hash from HISTORY: the image
 *     part is replaced with an in-band text marker. The model already
 *     analyzed the image in this conversation; the marker keeps the
 *     turn structure (the user message is not dropped) at ~100 chars
 *     instead of ~2M.
 *   - NEW image pasted this turn: always a NEW hash → forwarded raw.
 *     The user asking "what is THIS?" always gets real vision.
 *
 * Mode semantics (ArchCom 2026-09-15, refined):
 *   - 'marker' (default): two-phase describe runs for EVERY primary
 *     with images — including vision-capable primaries. The primary
 *     NEVER receives an image part; it receives the vision model's
 *     text description instead. Describe failures, a missing vision
 *     model, or images past the per-turn describe budget DEGRADE to
 *     the marker cycle below (never raw, never a throw).
 *   - 'raw': NOT "everything raw always" — it means the FIRST send
 *     of each image goes raw (no describe for vision-capable
 *     primaries), while repeat re-sends from history still become
 *     markers (the pre-v0.19 v0.18 lifecycle). Text-only primaries
 *     keep the ADR 0004 vision-fallback describe untouched.
 *
 * Scope/memory: an in-memory Set on the provider instance (per
 * window). A window reload clears it — one acceptable re-send of each
 * image per session, matching the two-phase persistent-cache posture
 * (which survives reloads; this one deliberately does not need to —
 * a reload also resets the harness-side history pressure anyway).
 *
 * Opt-out: `ollamaCloud.visionHistory.mode = 'raw'` (first-send raw;
 * repeats still become markers). Default: `'marker'`.
 */

import * as vscode from 'vscode';
import { logger } from './logger.js';
import { hasImageParts, isImageDataPart } from './convertPrimitives.js';
import { sha256ShortHex } from './visionTwoPhase.js';

// NOTE (circular import, deliberate and safe): visionTwoPhase.ts
// imports `degradedImageMarker` from THIS module while this module
// imports `sha256ShortHex` from visionTwoPhase.ts. Both are pure
// functions used at CALL time (neither module reads the other's
// bindings at top level), so the ESM circular reference resolves
// without TDZ issues — the same pattern VS Code extensions use for
// sibling util modules.

/** Setting value: `'marker'` (default) | `'raw'`. */
export type VisionHistoryMode = 'marker' | 'raw';

export function resolveVisionHistoryMode(): VisionHistoryMode {
  const mode = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<string>('visionHistory.mode', 'marker');
  return mode === 'raw' ? 'raw' : 'marker';
}

const MARKER_TEMPLATE =
  (hash: string) =>
  `[Image ${hash} — duplicate of an image already sent in this session; if you cannot find its analysis in the history above, ask the user to re-attach it]`;

/**
 * ArchCom 2026-09-15 variant (b) — DEGRADED-image marker. Used when the
 * unified describe path cannot produce a description (vision model
 * call failed, no vision model available, or the per-turn describe
 * budget was exhausted). The image part is replaced in the payload
 * with this marker so the primary NEVER receives image bytes (owner
 * directive: an image must not live in context in ANY outcome) and
 * the turn structure survives. The user can re-attach the image on a
 * later turn to retry the describe.
 */
export const degradedImageMarker = (hash: string): string =>
  `[Image ${hash} — attached image could not be described (no vision model available or the description failed); if you need its content, ask the user to re-attach it]`;

/**
 * ArchCom 2026-09-15 variant (b) — full-history degradation rewrite.
 * Replaces EVERY image part with the degraded marker (degradation
 * must not be silence and must not leak image bytes). Returns the
 * per-image result map so the caller can log which hashes degraded.
 * Returns `null` when the history carries no image parts (caller
 * skips the rewrite).
 */
export function degradeImagesToMarkers(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): { messages: vscode.LanguageModelChatRequestMessage[]; degradedHashes: string[] } | null {
  const degradedHashes: string[] = [];
  const result: vscode.LanguageModelChatRequestMessage[] = [];

  for (const message of messages) {
    if (!message) {
      continue;
    }
    const isUserWithImages =
      message.role === vscode.LanguageModelChatMessageRole.User &&
      hasImageParts(message.content);
    if (!isUserWithImages) {
      result.push(message);
      continue;
    }

    const newContent: Array<vscode.LanguageModelInputPart | unknown> = [];
    for (const part of message.content) {
      if (!isImageDataPart(part)) {
        newContent.push(part);
        continue;
      }
      const dataPart = part as vscode.LanguageModelDataPart;
      const data = dataPart.data;
      const hash =
        data && data.length > 0
          ? sha256ShortHex(Buffer.from(data))
          : 'no-image';
      degradedHashes.push(hash);
      newContent.push(
        new vscode.LanguageModelTextPart(`\n\n${degradedImageMarker(hash)}`),
      );
    }
    if (newContent.length === 0) {
      // Image-only message whose every part became a marker cannot be
      // empty — the markers are text parts. Defensive guard only.
      continue;
    }
    result.push({ ...message, content: newContent });
  }

  if (degradedHashes.length === 0) {
    return null;
  }
  return { messages: result, degradedHashes };
}

/**
 * Rewrites `messages`: first-send hashes pass through RAW and are
 * recorded; repeat hashes are substituted with the marker text.
 * Mode filtering (`'marker'` vs `'raw'`) is the CALLER's
 * responsibility — this function always applies the lifecycle.
 *
 * Returns a NEW array; untouched messages are shared by reference
 * (message objects are copied only where a substitution happened).
 */
export function applyVisionHistoryLifecycle(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  seenHashes: Set<string>,
): vscode.LanguageModelChatRequestMessage[] {
  let changed = false;
  const result: vscode.LanguageModelChatRequestMessage[] = [];

  for (const message of messages) {
    if (
      !message ||
      message.role !== vscode.LanguageModelChatMessageRole.User
    ) {
      result.push(message);
      continue;
    }
    let hasImage = false;
    for (const part of message.content) {
      if (isImageDataPart(part)) {
        hasImage = true;
        break;
      }
    }
    if (!hasImage) {
      result.push(message);
      continue;
    }

    const newContent: Array<vscode.LanguageModelInputPart | unknown> = [];
    for (const part of message.content) {
      if (!isImageDataPart(part)) {
        newContent.push(part);
        continue;
      }
      const dataPart = part as vscode.LanguageModelDataPart;
      const data = dataPart.data;
      const hash =
        data && data.length > 0
          ? sha256ShortHex(Buffer.from(data))
          : 'no-image';
      if (seenHashes.has(hash)) {
        // Second+ send of the same image — substitute the marker.
        changed = true;
        newContent.push(new vscode.LanguageModelTextPart(MARKER_TEMPLATE(hash)));
      } else {
        // First send this session — record and forward RAW.
        seenHashes.add(hash);
        newContent.push(part);
      }
    }
    result.push({ ...message, content: newContent });
  }

  if (changed) {
    logger.info(
      'vision history lifecycle: repeat images replaced with markers (first sends stay raw)',
    );
  }
  return changed ? result : [...messages];
}
