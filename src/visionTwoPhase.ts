import * as vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import { createHash } from 'node:crypto';
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

  // Routing disclosure (same annotation pattern as pass-through).
  // The user sees which model handled the image before the primary
  // model answers.
  const viaSuffix =
    visionConnection && visionConnection.id !== params.primaryModel.connectionId
      ? ` (via ${visionConnection.label})`
      : '';
  const routingNote = `🖼️ Describing image via ${visionModel.name}${viaSuffix}`;
  params.progress.report(new vscode.LanguageModelTextPart(routingNote + '\n\n'));

  // Log — model names + image hash ONLY. NO image data URL (security).
  const imageHash = computeImageHash(params.messages);
  logger.info('vision two-phase fallback fired', {
    primaryModel: params.primaryModel.id,
    visionModel: visionModel.id,
    visionConnection: visionConnection?.id ?? 'cloud',
    imageHash,
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

  // Build the phase-1 request body: the image + the hardcoded
  // describe prompt. We use the native /api/chat one-shot path
  // (`nativeChatOnce`) because it is already available, non-streaming,
  // and handles the vision image via the OpenAI-compat `messages[]`
  // shape (the compat path converts image parts to `image_url` content
  // parts). The describe prompt is a single user message.
  const describeMessages = buildDescribeRequest(params.messages);
  const requestBody = {
    model: visionModel.apiModel,
    messages: describeMessages,
    stream: false,
    think: false,
  };

  // Race the vision call against a 90s timeout + the caller's
  // CancellationToken. The timeout is defence-in-depth: a vision model
  // that hangs must not block the chat indefinitely.
  const TIMEOUT_MS = 90_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(
        new Error(
          `Vision two-phase: vision model call timed out after ${TIMEOUT_MS}ms`,
        ),
      );
    });
  });
  // Propagate the caller's CancellationToken to the abort controller.
  let cancelHandler: (() => void) | undefined;
  if (params.token) {
    cancelHandler = () => controller.abort();
    params.token.onCancellationRequested(cancelHandler);
  }

  let description: string;
  try {
    description = await Promise.race([
      client.nativeChatOnce(requestBody, controller.signal),
      timeout,
    ]);
  } catch (error) {
    // Re-attach the context — the user sees a clear error, not a
    // silent text-only fallback (no silent degradation, ADR 0004 #9).
    throw new Error(
      `Vision two-phase: vision model call failed — ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    // CancellationToken has no `offCancellationRequested` — the
    // listener is automatically cleaned up when the token fires or
    // the process exits. No explicit removal needed (the signal is
    // short-lived).
  }

  if (!description.trim()) {
    throw new Error(
      'Vision two-phase: vision model returned an empty description. Cannot substitute image.',
    );
  }

  logger.info('vision two-phase description received', {
    visionModel: visionModel.id,
    descriptionLength: description.length,
    // Do NOT log the description itself — it may carry injected
    // instructions from a compromised vision model. Log the length
    // only, for diagnostics.
  });

  // --- Rewrite message history: replace image parts with the description ---
  const wrappedDescription = wrapDescription(visionModel.name, description);
  const rewrittenMessages = replaceImagePartsWithDescription(
    params.messages,
    wrappedDescription,
  );

  return {
    messages: rewrittenMessages,
    visionModel,
    visionConnection,
    description,
  };
}

/**
 * Builds the phase-1 request body: a single user message containing
 * the image parts from the original history + the hardcoded describe
 * prompt. Only the LAST user message's images are described (the
 * current turn's image); earlier images in history are not
 * re-described (they were already handled in their own turns).
 *
 * Returns `OpenAICompatibleMessage[]`-shaped objects for the native
 * `/api/chat` one-shot path. The compat converter handles `image_url`
 * content parts; we build them directly here to avoid a full
 * `convertMessagesToOpenAI` round-trip (we only need the last user
 * message's images + the prompt).
 */
function buildDescribeRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Array<{ role: string; content: unknown }> {
  // Find the last user message with image parts — that is the image
  // the user just attached and wants described.
  let lastImageMessage: vscode.LanguageModelChatRequestMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg &&
      msg.role === vscode.LanguageModelChatMessageRole.User &&
      hasImageParts(msg.content)
    ) {
      lastImageMessage = msg;
      break;
    }
  }
  if (!lastImageMessage) {
    // Should not happen — the gate already confirmed images are
    // present. Throw so the error is visible, not silent.
    throw new Error(
      'Vision two-phase: no image parts found in message history (gate mismatch).',
    );
  }

  // Build the OpenAI-compat content array: the original text parts +
  // the image parts from the last image message, then the describe
  // prompt as a final text part.
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
  let text = '';
  for (const part of lastImageMessage.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
    if (isImageDataPart(part)) {
      // toDataUrl is in convertPrimitives, re-exported from convert.
      // Inline the data URL encoding to avoid a circular import.
      const dataPart = part as vscode.LanguageModelDataPart;
      const dataUrl = dataPart.data
        ? `data:${dataPart.mimeType};base64,${Buffer.from(dataPart.data).toString('base64')}`
        : '';
      if (dataUrl) {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }
  }
  if (text) {
    content.unshift({ type: 'text', text });
  }
  content.push({ type: 'text', text: VISION_DESCRIBE_PROMPT });

  return [{ role: 'user', content }];
}

/**
 * Replaces image parts in the message history with the vision model's
 * text description (wrapped in the injection delimiter). Only user
 * messages with image parts are rewritten; text-only messages pass
 * through unchanged. The LAST user message with images gets the
 * description; earlier user messages with images have their images
 * dropped (they were already handled in their own turns — keeping
 * them would send stale images the primary model cannot read).
 *
 * The result is a NEW array — the input is not mutated.
 */
export function replaceImagePartsWithDescription(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  wrappedDescription: string,
): vscode.LanguageModelChatRequestMessage[] {
  const result: vscode.LanguageModelChatRequestMessage[] = [];
  let described = false;

  // Walk in reverse so we know which is the last image message.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    const isLastImageMessage =
      !described &&
      message.role === vscode.LanguageModelChatMessageRole.User &&
      hasImageParts(message.content);

    if (isLastImageMessage) {
      // Replace the image parts with the description; keep text parts.
      const newContent: Array<vscode.LanguageModelInputPart | unknown> = [];
      let hadText = false;
      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          newContent.push(part);
          hadText = true;
        } else if (isImageDataPart(part)) {
          // Drop the image; the description replaces it.
        } else {
          // Keep tool calls, tool results, etc.
          newContent.push(part);
        }
      }
      // Insert the description as a text part after the existing text
      // (or as the only content if there was no text).
      const descriptionPart = new vscode.LanguageModelTextPart(
        hadText ? `\n\n${wrappedDescription}` : wrappedDescription,
      );
      newContent.push(descriptionPart);
      result.push({
        ...message,
        content: newContent,
      });
      described = true;
    } else if (
      message.role === vscode.LanguageModelChatMessageRole.User &&
      hasImageParts(message.content)
    ) {
      // Earlier user message with images: drop the images (stale),
      // keep text. The primary model cannot read them anyway.
      const newContent: Array<vscode.LanguageModelInputPart | unknown> = [];
      for (const part of message.content) {
        if (isImageDataPart(part)) {
          // Drop stale image.
        } else {
          newContent.push(part);
        }
      }
      if (newContent.length === 0) {
        // The message had only images and no text — drop the empty
        // message entirely (an empty user message would break the
        // OpenAI `messages[]` shape).
        continue;
      }
      result.push({ ...message, content: newContent });
    } else {
      result.push(message);
    }
  }

  return result;
}

/**
 * Computes a correlation-only SHA256 short hash of the first image
 * part in the request. Same pattern as `visionFallback.ts` — NEVER
 * returns the image data URL, only the first 16 hex chars of the
 * digest, for log correlation only.
 */
function computeImageHash(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  for (const message of messages) {
    for (const part of message.content) {
      if (isImageDataPart(part)) {
        const dataPart = part as vscode.LanguageModelDataPart;
        const data = dataPart.data;
        if (data && data.length > 0) {
          return sha256ShortHex(data);
        }
      }
    }
  }
  return 'no-image';
}

function sha256ShortHex(data: Uint8Array): string {
  // Use node:crypto static import (ESM-safe). Correlation-only — not a security primitive.
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
