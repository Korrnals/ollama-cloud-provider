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
 *
 * v0.21.0 D-3 (owner-ratified 2026-10-02) — raw-resend cap: a hash
 * whose raw send failed `rawResendCap` times (default 3, config
 * `ollamaCloud.visionHistory.rawResendCap`, 0 = unlimited legacy)
 * degrades permanently for the session to the never-sent marker.
 */

import * as vscode from 'vscode';
import { logger } from './logger.js';
import { isImageDataPart } from './convertPrimitives.js';
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

/**
 * v0.21.0 D-3 (owner-ratified 2026-10-02) — default number of failed
 * raw sends after which an image hash degrades to a marker for the
 * rest of the session. See {@link resolveRawResendCap}.
 */
export const DEFAULT_RAW_RESEND_CAP = 3;

/**
 * v0.21.0 D-3 — resolves `ollamaCloud.visionHistory.rawResendCap`.
 * Caps the resend amplifier RCA: a turn whose stream fails never
 * commits its pending hashes (v0.20.1 commit-on-success), so every
 * subsequent turn re-sent those images as RAW base64 — requestChars
 * spiked (3.3M chars observed), over-window compaction fired and
 * evicted mass history. After this many failed attempts the hash
 * degrades permanently (per session) to the never-sent marker.
 * 0 = unlimited raw re-sends (the pre-v0.21 legacy behavior).
 * Invalid values clamp to the default.
 */
export function resolveRawResendCap(): number {
  const value = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<unknown>('visionHistory.rawResendCap', DEFAULT_RAW_RESEND_CAP);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RAW_RESEND_CAP;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * v0.22.3 (task v0223-vision-cache-warm, D2) — the repeat-marker text
 * for a hash the TurnLedger committed as sent RAW this session but the
 * persistent description cache does not hold (the D1 warm-up failed or
 * has not resolved yet). Exported for the two-phase path's
 * markerOverlay: the mid-session switch (vision-capable primary →
 * text-only primary) resolves such hashes through this marker instead
 * of re-describing them every turn. BYTE-IDENTICAL to what
 * `applyVisionHistoryLifecycle` substitutes for a committed repeat —
 * it must stay the exact MARKER_TEMPLATE shape, and the plain-template
 * export replaces the previous duplicated literal.
 */
export const sentImageRepeatMarker =
  (hash: string) =>
  `[Image ${hash} — duplicate of an image already sent in this session; if you cannot find its analysis in the history above, ask the user to re-attach it]`;

const MARKER_TEMPLATE = sentImageRepeatMarker;

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
 * v0.21.0 D-3 — marker for a hash that exhausted the raw-resend cap:
 * the same in-band marker shape as a committed repeat, with an
 * appended note stating the image never reached the model. The model
 * must not mistake a capped image for one it has already analyzed.
 */
export const neverSentImageMarker = (hash: string, attempts: number): string =>
  `${MARKER_TEMPLATE(hash)} [image never successfully sent — ${attempts} attempts failed]`;

/**
 * Rewrites `messages`: first-send hashes pass through RAW and are
 * recorded; repeat hashes are substituted with the marker text.
 * Mode filtering (`'marker'` vs `'raw'`) is the CALLER's
 * responsibility — this function always applies the lifecycle.
 *
 * HASH-CONTAINER CONTRACT (v0.20.1 — commit-on-success): the function
 * takes TWO sets — the instance-level committed set (`sentHashes`:
 * images whose RAW send completed successfully this window) and a
 * PER-TURN pending set (`pendingHashes`: raw first-sends recorded this
 * request, committed to `sentHashes` by the caller only after the
 * stream resolved). A hash in EITHER set → the image already reached
 * the model (or is in-flight in THIS request) → substituted with the
 * marker. Unknown hash → recorded into pending + forwarded RAW: the
 * model sees it on the turn that matters, and the caller commits the
 * hash only on success — a failed/cancelled turn leaves it
 * uncommitted, so the next turn re-sends the image RAW (RCA
 * 2026-09-25: a hash committed at dispatch time survived a DNS-failed
 * turn, and the image was never shown to the model).
 *
 * v0.21.0 D-3 — `cappedHashes` (optional) carries hashes whose failed
 * raw sends reached `rawResendCap`: those degrade to the never-sent
 * marker INSTEAD of a raw re-send, capping the resend amplifier.
 *
 * Returns a NEW array; untouched messages are shared by reference
 * (message objects are copied only where a substitution happened).
 */
export function applyVisionHistoryLifecycle(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  sentHashes: ReadonlySet<string>,
  pendingHashes: Set<string>,
  cappedHashes?: ReadonlyMap<string, number>,
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
      const cappedAttempts = cappedHashes?.get(hash);
      if (cappedAttempts !== undefined) {
        // v0.21.0 D-3 — the hash exhausted the raw-resend cap: degrade
        // permanently (per session) to the never-sent marker instead of
        // re-uploading raw base64. Not recorded into pending — nothing
        // raw is being sent for this hash.
        changed = true;
        newContent.push(
          new vscode.LanguageModelTextPart(
            neverSentImageMarker(hash, cappedAttempts),
          ),
        );
      } else if (sentHashes.has(hash) || pendingHashes.has(hash)) {
        // Second+ send of the same image — substitute the marker.
        changed = true;
        newContent.push(new vscode.LanguageModelTextPart(MARKER_TEMPLATE(hash)));
      } else {
        // First send this session AND this turn — record into the
        // PENDING container and forward RAW. The caller commits the
        // pending hashes into the seen set only after the stream
        // succeeds.
        pendingHashes.add(hash);
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
