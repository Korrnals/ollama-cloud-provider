/**
 * ADR 0013 lifecycle extension (2026-09-15) — image resend inflation
 * on the NATIVE vision path.
 *
 * RCA (mnemos 1731bef7): VS Code re-sends the full immutable history
 * on every turn, images included. The two-phase path (text-only
 * primary) already replaces history images with cached descriptions
 * — but the native vision path (primary HAS imageInput) forwarded the
 * raw base64 forever. One screenshot ≈ 1.9–2.0M chars of base64 PER
 * TURN: the owner's session grew to requestChars=2.46M, the harness
 * carried those megabytes into subagent delegations, and the
 * delegations died on context overflow (D408 "no output") before
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
 * Scope/memory: an in-memory Set on the provider instance (per
 * window). A window reload clears it — one acceptable re-send of each
 * image per session, matching the two-phase persistent-cache posture
 * (which survives reloads; this one deliberately does not need to —
 * a reload also resets the harness-side history pressure anyway).
 *
 * Opt-out: `ollamaCloud.visionHistory.mode = 'raw'` restores the
 * pre-fix behaviour (every send raw). Default: `'marker'`.
 */

import * as vscode from 'vscode';
import { logger } from './logger.js';
import { isImageDataPart } from './convertPrimitives.js';
import { sha256ShortHex } from './visionTwoPhase.js';

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
