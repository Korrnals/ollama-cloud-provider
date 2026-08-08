// ADR 0006 — shared conversion primitives extracted from `convert.ts`.
//
// Both the `/chat/completions` converter (`convert.ts`) and the
// `/v1/responses` converter (`convertResponses.ts`) need the same
// low-level helpers: image-part detection, data-URL encoding, tool-
// result content serialization, role mapping. Extracting them here
// avoids two copies of the same security-sensitive logic (the data-URL
// encoding and image detection are referenced by the vision gate).
//
// `convert.ts` re-exports these for backward compatibility so existing
// imports (`import { hasImageParts } from './convert.js'`) keep working
// and the 322-test regression suite is untouched.
import * as vscode from 'vscode';

/**
 * Returns true when the message's content array contains at least one
 * `vscode.LanguageModelDataPart` with an `image/*` mime type. Used by
 * the provider to detect image-bearing requests and reject them when
 * the selected model does not support vision.
 *
 * The duck-typing fallback mirrors the canonical `LanguageModelDataPart`
 * shape so the stub-based tests can construct data parts without a real
 * `vscode.LanguageModelDataPart` constructor.
 */
export function hasImageParts(content: readonly unknown[]): boolean {
  return content.some(isImageDataPart);
}

/**
 * Returns true if `part` is an `image/*` data part — either a real
 * `vscode.LanguageModelDataPart` or a duck-typed object with `mimeType`
 * (string starting with `image/`) and `data` (Uint8Array).
 */
export function isImageDataPart(part: unknown): boolean {
  return isDataPart(part) && part.mimeType.toLowerCase().startsWith('image/');
}

function isDataPart(
  part: unknown,
): part is vscode.LanguageModelDataPart {
  if (part instanceof vscode.LanguageModelDataPart) {
    return true;
  }
  if (!part || typeof part !== 'object') {
    return false;
  }
  const candidate = part as { mimeType?: unknown; data?: unknown };
  return (
    typeof candidate.mimeType === 'string' &&
    candidate.data instanceof Uint8Array
  );
}

/**
 * Converts a `LanguageModelDataPart` (image) to a `data:` URL — the
 * form OpenAI-compatible endpoints expect in the `image_url.url` field
 * (`/chat/completions`) or the `image_url` field (`/v1/responses`).
 * The base64 encoding is deterministic and synchronous.
 */
export function toDataUrl(part: vscode.LanguageModelDataPart): string {
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

/**
 * Serializes a tool-result part list to a single string. Prefers the
 * concatenated text of all `LanguageModelTextPart` values; falls back
 * to `JSON.stringify(parts)` when no text part is present (so structured
 * tool output is preserved rather than dropped).
 */
export function serializeToolResultContent(parts: readonly unknown[]): string {
  const text = extractText(parts);
  return text || JSON.stringify(parts);
}

/**
 * Maps a `LanguageModelChatMessageRole` to the OpenAI-style role
 * string. The `/chat/completions` path uses `'user' | 'assistant'`; the
 * `/v1/responses` path uses `'user' | 'assistant' | 'system'` (system
 * is hoisted to `instructions` before reaching here, but the helper
 * stays permissive).
 */
export function mapRole(
  role: vscode.LanguageModelChatMessageRole,
): 'user' | 'assistant' | 'system' {
  // The official `@types/vscode` enum declares only `User` and
  // `Assistant` — there is no `System` member. VS Code does not pass
  // system messages through `LanguageModelChatRequestMessage` with a
  // system role in the stable API. The test stub, however, defines a
  // `System` member (value 1) to exercise the `/v1/responses`
  // instructions-hoist path. Comparing against the two known members
  // and falling through to `'system'` for any other value keeps both
  // the real API (User=1, Assistant=2 → no system messages arrive)
  // and the stub (System=1, User=2, Assistant=3) consistent.
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  if (role === vscode.LanguageModelChatMessageRole.User) {
    return 'user';
  }
  return 'system';
}

function extractText(parts: readonly unknown[]): string {
  let text = '';
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}
