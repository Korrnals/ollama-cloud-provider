import * as vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthManager } from './auth.js';
import {
  openAiBaseUrl,
  type ConnectionConfig,
} from './connections.js';
import {
  hasImageParts,
  isImageDataPart,
} from './convert.js';
import { logger } from './logger.js';
import type { ModelDefinition } from './modelCatalog.js';
import { OllamaClient } from './ollamaClient.js';
import {
  resolveVisionModel,
  type VisionTarget,
} from './visionFallback.js';
import {
  createProductionSsrfGuard,
  type SsrfGuard,
} from './ssrfGuard.js';
import { isSocketCloseError } from './retry.js';

/**
 * Vision Fallback Two-Phase (supersedes ADR 0004 pass-through as the
 * DEFAULT path per owner directive 2026-08-19).
 *
 * Two-phase flow:
 *   1. Vision model (e.g. `minimax-m3`) receives the image + a
 *      describe prompt → returns a text description of the image.
 *   2. Primary model receives the text description (replacing the
 *      image part) + the original user question → answers normally.
 *
 * This module exposes `executeTwoPhaseVision`, which performs phase 1
 * (non-streaming vision call) and returns the rewritten message
 * history so the provider can continue with its normal primary-model
 * dispatch for phase 2. Keeping phase 2 in the provider avoids
 * duplicating the ~200-line endpoint dispatch (responses / chat /
 * native + 404 fallback) that the primary path already owns.
 *
 * Security (ADR 0004 security invariants, preserved):
 *   - SEC-03 per-connection `allowedBaseUrls` whitelist — the vision
 *     fetch goes through `OllamaClient.nativeChatOnce` with the
 *     vision connection's whitelist.
 *   - Per-connection key isolation — the vision connection's key is
 *     used only for the vision fetch.
 *   - SEC-02 `redactSensitive` covers any log; image data URLs are
 *     NEVER logged (only the SHA256 short hash, same as pass-through).
 *   - `scope: application` on the new `visionFallback.mode` setting.
 *   - Zero new runtime dependencies.
 *
 * Indirect prompt-injection surface (reopened by two-phase, ADR 0004
 * alt A). The vision model's text description flows into the primary
 * model's context — a compromised vision model could emit
 * "IGNORE PREVIOUS INSTRUCTIONS...". Defence-in-depth: the
 * description is wrapped in a delimiter that marks it as
 * model-generated image content, not user instruction:
 *   "[Image description from <visionModel>: ...]"
 * This is a PARTIAL mitigation. The full assistant-role-wrapper
 * defence recommended by ADR 0004 alt A is a follow-up for ArchCom.
 */

/**
 * The hardcoded describe prompt sent to the vision model in phase 1.
 * NOT a setting — a configurable prompt is a prompt-injection channel
 * (ADR 0004 constraint 7, Senior Security Engineer blocker #2). The
 * prompt asks for a factual description, not interpretation, to
 * minimise the injection surface.
 */
export const VISION_DESCRIBE_PROMPT =
  'Describe this image in detail — text, layout, visible elements — so another model can answer a question about it.';

/**
 * The delimiter wrapping the vision model's description when it
 * replaces the image part in the message history. Marks the content
 * as model-generated image description, not user instruction
 * (defence-in-depth against indirect prompt injection).
 */
export function wrapDescription(
  visionModelName: string,
  description: string,
): string {
  return `[Image description from ${visionModelName}: ${description}]`;
}

/**
 * Session-level description cache: image hash → wrapped description.
 *
 * VS Code owns the conversation history and re-sends it on EVERY
 * turn — image parts from earlier turns are still in the payload
 * even on text-only turns, and the primary model cannot read them.
 * Without this cache every subsequent turn would re-describe the
 * same image with a fresh vision-model call (wasteful, slow, and it
 * re-fires the "🖼️ Describing image" annotation on text-only turns).
 * With the cache an already-described image is replaced by its
 * stored description SILENTLY — no vision call, no annotation.
 *
 * Key: SHA256 short hash of the image bytes (16 hex chars) — the
 * same correlation hash used in logs. Value: the WRAPPED description
 * (`wrapDescription` output), so the injection delimiter survives
 * across turns.
 */
const imageDescriptionCache = new Map<string, string>();

/** Cap for `imageDescriptionCache` (oldest entries evicted first). */
const IMAGE_DESCRIPTION_CACHE_MAX = 100;

/**
 * Persistent cache file (set at activation from globalStorage).
 *
 * The in-memory cache dies with the extension host on every window
 * reload; VS Code re-sends the conversation history (with all its
 * image parts) on the first post-reload turn, which would force a
 * full re-description of every image in history. Persisting the
 * hash → description map to `<globalStorage>/vision-description-cache.json`
 * makes the cache survive reloads (owner directive 2026-08-20).
 */
let cacheFilePath: string | null = null;

/**
 * Sets the persistent cache file path and hydrates the in-memory
 * cache from it. Called once at extension activation with the
 * globalStorage path (mirrors `logger.setDebugLogPath`). Pass `null`
 * to disable persistence (tests).
 */
export function setVisionCachePath(path: string | null): void {
  cacheFilePath = path;
  if (path) {
    try {
      const raw = fs.readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [hash, description] of Object.entries(parsed)) {
        if (typeof description === 'string' && description) {
          imageDescriptionCache.set(hash, description);
        }
      }
    } catch {
      // Missing or corrupt file = fresh cache. Not an error.
    }
  }
}

/** Writes the cache to disk (best-effort — failures log a warning). */
function persistCache(): void {
  if (!cacheFilePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    // v0.13.0 — atomic write. A direct `writeFileSync` interrupted by
    // extension-host shutdown leaves a truncated JSON file, and the
    // hydration in `setVisionCachePath` treats corrupt JSON as "fresh
    // cache" — silently wiping EVERY cached description (the exact
    // failure mode the persistent cache exists to prevent). Write to a
    // temp sibling then `renameSync` (atomic within one filesystem):
    // a reader sees either the complete old file or the complete new
    // one, never a half-written one.
    const tmpPath = `${cacheFilePath}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(Object.fromEntries(imageDescriptionCache)),
      'utf8',
    );
    fs.renameSync(tmpPath, cacheFilePath);
  } catch (error) {
    logger.warn(
      'vision two-phase: failed to persist description cache: %s',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Test helper — clears the session-level description cache. */
export function clearImageDescriptionCache(): void {
  imageDescriptionCache.clear();
}

/** Parameters for `executeTwoPhaseVision`. */
export interface TwoPhaseParams {
  readonly primaryModel: ModelDefinition;
  readonly primaryConnection: ConnectionConfig | undefined;
  readonly messages: readonly vscode.LanguageModelChatRequestMessage[];
  readonly options: vscode.ProvideLanguageModelChatResponseOptions;
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  readonly token: CancellationToken;
  readonly authManager: AuthManager;
  readonly catalog: readonly ModelDefinition[];
  readonly connections: readonly ConnectionConfig[];
}

/**
 * Result of the two-phase vision fallback phase 1.
 * - `messages` — the rewritten message history with image parts
 *   replaced by the vision model's text description. The provider
 *   continues its normal dispatch with these.
 * - `visionModelName` — the vision model that produced the
 *   description (for logging / disclosure).
 */
export interface TwoPhaseResult {
  readonly messages: vscode.LanguageModelChatRequestMessage[];
  readonly visionModel: ModelDefinition;
  readonly visionConnection: ConnectionConfig | undefined;
  readonly description: string;
}

/**
 * Executes phase 1 of the two-phase vision fallback: resolve the
 * vision model + connection, call the vision model NON-STREAMING
 * with the image + the hardcoded describe prompt, then rewrite the
 * message history so image parts are replaced by the vision model's
 * text description (wrapped in the injection delimiter).
 *
 * The provider then continues with phase 2 — streaming the primary
 * model's response using the rewritten history via its normal
 * endpoint dispatch. This avoids duplicating the ~200-line endpoint
 * dispatch (responses / chat / native + 404 fallback).
 *
 * Throws when no vision model is found (no silent degradation — the
 * user gets an actionable error, same contract as pass-through).
 *
 * Security: the image data URL is NEVER logged. Only the SHA256
 * short hash of the first image part is logged for correlation
 * (same pattern as `visionFallback.ts`).
 */
export async function executeTwoPhaseVision(
  params: TwoPhaseParams,
): Promise<TwoPhaseResult> {
  // --- Resolve vision model + connection (shared with pass-through) ---
  const target: VisionTarget | null = resolveVisionModel(
    params.primaryModel,
    params.primaryConnection,
    params.catalog,
    params.connections,
  );
  if (!target) {
    throw new Error(
      'No vision-capable model found for two-phase vision fallback. Configure `ollamaCloud.visionFallback.model` or attach a vision-capable model to the primary connection.',
    );
  }

  const { model: visionModel, connection: visionConnection } = target;

  // Per-connection key isolation (same as pass-through).
  const apiKey = visionConnection
    ? await params.authManager.getApiKeyForConnection(visionConnection)
    : await params.authManager.getApiKey();
  if (!apiKey && (!visionConnection || visionConnection.requiresApiKey)) {
    throw new Error(
      'Ollama Cloud API key not configured for the vision fallback connection. Run "Ollama Cloud: Set API Key".',
    );
  }

  // --- Collect ALL image parts across the history (hash → base64) ---
  // VS Code re-sends the full history every turn, so images from
  // earlier turns are in the payload too. Each unique image is
  // described ONCE and cached; stale images are replaced from the
  // cache without a new vision call.
  const uniqueImages = new Map<string, string>();
  for (const message of params.messages) {
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }
    for (const part of message.content) {
      if (isImageDataPart(part)) {
        const dataPart = part as vscode.LanguageModelDataPart;
        const data = dataPart.data;
        if (data && data.length > 0) {
          const buffer = Buffer.from(data);
          uniqueImages.set(sha256ShortHex(buffer), buffer.toString('base64'));
        }
      }
    }
  }
  if (uniqueImages.size === 0) {
    // Defensive — the provider gate guarantees ≥1 image before
    // calling. A mismatch here means the gate and this function
    // disagree; fail loudly, not silently.
    throw new Error(
      'Vision two-phase: no image parts found in message history (gate mismatch).',
    );
  }
  const uncachedHashes = [...uniqueImages.keys()].filter(
    (hash) => !imageDescriptionCache.has(hash),
  );
  const cacheHits = uniqueImages.size - uncachedHashes.length;

  // Routing disclosure (same annotation pattern as pass-through) —
  // ONLY when there are NEW images to describe. On text-only turns
  // where every image is already cached, the substitution is silent:
  // no vision call, no "Describing image" annotation — control goes
  // straight to the primary model (owner directive 2026-08-20).
  if (uncachedHashes.length > 0) {
    const viaSuffix =
      visionConnection && visionConnection.id !== params.primaryModel.connectionId
        ? ` (via ${visionConnection.label})`
        : '';
    const routingNote = `🖼️ Describing image via ${visionModel.name}${viaSuffix}`;
    params.progress.report(new vscode.LanguageModelTextPart(routingNote + '\n\n'));
  }

  // Log — model names + image hashes ONLY. NO image data URL (security).
  logger.info('vision two-phase fallback fired', {
    primaryModel: params.primaryModel.id,
    visionModel: visionModel.id,
    visionConnection: visionConnection?.id ?? 'cloud',
    imageHashes: [...uniqueImages.keys()],
    cacheHits,
    cacheMisses: uncachedHashes.length,
  });

  // --- Phase 1: non-streaming vision call ---
  // Build the vision connection's OllamaClient (SEC-03 whitelist
  // enforced at the fetch boundary via assertBaseUrlAllowedOrThrow).
  const clientBaseUrl = visionConnection
    ? openAiBaseUrl(visionConnection)
    : params.authManager.getBaseUrl();
  const isLocalConnection = visionConnection?.type === 'local';
  const ssrfGuard: SsrfGuard = isLocalConnection
    ? createProductionSsrfGuard({ allowLoopback: true, allowPrivateRanges: true })
    : createProductionSsrfGuard({
        allowLoopback: false,
        advice: 'Check the URL or your ollamaCloud.allowedBaseUrls whitelist.',
      });
  const client = new OllamaClient(
    clientBaseUrl,
    apiKey ?? '',
    visionConnection,
    'compat',
    ssrfGuard,
  );

  // --- Phase 1: describe each UNCACHED image (non-streaming) ---
  // One `nativeChatOnce` call per unique uncached image: the describe
  // prompt depends ONLY on the image, so the cache key stays sound
  // (same image → same description regardless of surrounding text).
  // Per-call retry on socket-close errors — the Ollama Cloud server
  // regularly ECONNRESETs mid-flight; without local retry a flaky
  // vision call killed the whole chat turn (recovered only by VS
  // Code retrying the ENTIRE request).
  const TIMEOUT_MS = 90_000;
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 1_000;

  let currentController: AbortController | undefined;
  if (params.token) {
    // CancellationToken has no `offCancellationRequested` — the
    // listener dies with the token; the per-call controllers are
    // short-lived, so no explicit cleanup is needed.
    params.token.onCancellationRequested(() => currentController?.abort());
  }

  const freshDescriptions: string[] = [];
  for (const hash of uncachedHashes) {
    const base64 = uniqueImages.get(hash);
    if (!base64) {
      continue;
    }
    const requestBody = {
      model: visionModel.apiModel,
      messages: [
        { role: 'user', content: VISION_DESCRIBE_PROMPT, images: [base64] },
      ],
      stream: false,
      think: false,
    };
    let description = '';
    let failure: unknown;
    let abortedByTimeout = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      currentController = new AbortController();
      const timer = setTimeout(() => {
        abortedByTimeout = true;
        currentController?.abort();
      }, TIMEOUT_MS);
      try {
        description = await client.nativeChatOnce(
          requestBody,
          currentController.signal,
        );
        failure = undefined;
        abortedByTimeout = false;
        break;
      } catch (error) {
        failure = error;
        const message = error instanceof Error ? error.message : String(error);
        // Timeout aborts ARE retryable: the vision model latency
        // varies widely (observed: the same image timed out at 90s,
        // then described in 35s on the next attempt). User
        // cancellation is NOT retryable — it aborts the controller
        // without setting `abortedByTimeout`.
        const retryable =
          abortedByTimeout ||
          isSocketCloseError(error) ||
          /ECONNRESET|socket hang up/i.test(message);
        if (!retryable || attempt === MAX_ATTEMPTS) {
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, BASE_DELAY_MS * 2 ** (attempt - 1)),
        );
      } finally {
        clearTimeout(timer);
      }
    }
    if (failure) {
      const detail = abortedByTimeout
        ? `vision model call timed out after ${TIMEOUT_MS}ms`
        : failure instanceof Error
          ? failure.message
          : String(failure);
      // Re-attach the context — the user sees a clear error, not a
      // silent text-only fallback (no silent degradation, ADR 0004 #9).
      throw new Error(`Vision two-phase: vision model call failed — ${detail}`);
    }
    if (!description.trim()) {
      throw new Error(
        'Vision two-phase: vision model returned an empty description. Cannot substitute image.',
      );
    }
    logger.info('vision two-phase description received', {
      visionModel: visionModel.id,
      imageHash: hash,
      descriptionLength: description.length,
      // Do NOT log the description itself — it may carry injected
      // instructions from a compromised vision model. Log the length
      // only, for diagnostics.
    });
    const wrapped = wrapDescription(visionModel.name, description);
    imageDescriptionCache.set(hash, wrapped);
    freshDescriptions.push(wrapped);
  }

  // Evict oldest entries when over the cap (insertion order = age),
  // then persist so the cache survives the next extension restart.
  while (imageDescriptionCache.size > IMAGE_DESCRIPTION_CACHE_MAX) {
    const oldest = imageDescriptionCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    imageDescriptionCache.delete(oldest);
  }
  persistCache();

  // --- Rewrite history: EVERY image part → its cached description ---
  // After this, control returns IMMEDIATELY to the primary model via
  // the provider's normal dispatch — the vision fallback's job is
  // done (owner directive 2026-08-20: describe → hand back, no more).
  const rewrittenMessages = replaceImagesWithCachedDescriptions(
    params.messages,
    imageDescriptionCache,
  );

  return {
    messages: rewrittenMessages,
    visionModel,
    visionConnection,
    description: freshDescriptions.join('\n\n'),
  };
}

/**
 * Replaces EVERY image part in the message history with its cached
 * description (wrapped in the injection delimiter). Every user
 * message carrying image parts is rewritten; text-only messages pass
 * through unchanged.
 *
 * Cache semantics: each image part is looked up by its content hash.
 * A cache hit (image described in an earlier turn) is substituted
 * SILENTLY — no vision call was made for it this turn. A miss should
 * not happen here (uncached images were described and cached in
 * phase 1 above); defensively, an uncached image is dropped with a
 * warning rather than sent raw to a non-vision primary model.
 *
 * The result is a NEW array — the input is not mutated.
 */
function replaceImagesWithCachedDescriptions(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  cache: ReadonlyMap<string, string>,
): vscode.LanguageModelChatRequestMessage[] {
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
      if (part instanceof vscode.LanguageModelTextPart) {
        newContent.push(part);
      } else if (isImageDataPart(part)) {
        const dataPart = part as vscode.LanguageModelDataPart;
        const data = dataPart.data;
        const hash =
          data && data.length > 0
            ? sha256ShortHex(Buffer.from(data))
            : 'no-image';
        const cached = cache.get(hash);
        if (cached) {
          // Substitute the cached (or just-fresh) description.
          newContent.push(new vscode.LanguageModelTextPart(`\n\n${cached}`));
        } else {
          // Defensive: uncached image (should not happen — phase 1
          // caches all misses). Drop it rather than send a raw image
          // to a non-vision primary model.
          logger.warn(
            'vision two-phase: uncached image dropped during rewrite (hash=%s)',
            hash,
          );
        }
      } else {
        // Keep tool calls, tool results, etc.
        newContent.push(part);
      }
    }

    if (newContent.length === 0) {
      // The message had only images and none resolved to a
      // description — drop the empty message entirely (an empty user
      // message would break the OpenAI `messages[]` shape).
      continue;
    }
    result.push({ ...message, content: newContent });
  }

  return result;
}

function sha256ShortHex(data: Uint8Array): string {
  // Use node:crypto static import (ESM-safe). Correlation-only — not a security primitive.
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
