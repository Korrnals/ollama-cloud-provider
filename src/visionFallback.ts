import * as vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import { createHash } from 'node:crypto';
import { AuthManager } from './auth.js';
import {
  findConnection,
  openAiBaseUrl,
  type ConnectionConfig,
} from './connections.js';
import {
  convertMessagesToOpenAI,
  countOpenAIRequestChars,
  hasImageParts,
} from './convert.js';
import { logger } from './logger.js';
import type { ModelDefinition } from './modelCatalog.js';
import { OllamaClient } from './ollamaClient.js';
import type { UsageInfo } from './protocolTypes.js';

/**
 * Vision Fallback Pass-through (ADR 0004).
 *
 * When the primary model cannot handle an image and the user has
 * enabled `ollamaCloud.visionFallback.enabled`, the extension swaps
 * to a vision-capable model for THAT single turn. The vision model
 * answers the user directly via the existing `streamChat`. The
 * primary model is not involved in that turn; the next turn returns
 * to the primary.
 *
 * Constraints (binding — ADR 0004):
 *   1. Single-hop. One vision call per turn. No loop, no multi-hop.
 *   2. Opt-in, default off (`visionFallback.enabled`).
 *   5. Auto-search first vision-capable model when model not set.
 *   6. Vision endpoint = `ConnectionConfig` (SEC-03 per-connection
 *      whitelist + key isolation). Never a standalone URL.
 *   7. Hardcoded prompt — N/A for pure pass-through: the user's
 *      original message + image is forwarded to the vision model
 *      UNCHANGED. No intermediate prompt is injected.
 *   8. Routing disclosure notification. Never silent.
 *   9. No silent degradation — fallback disabled + primary non-vision
 *      → throw (preserved in `provider.ts`).
 *
 * This module exposes three pure-ish entry points used by the
 * provider: `shouldFallback`, `resolveVisionModel`, and
 * `executePassThrough`.
 */

/** Resolved vision target — the model + the connection it lives on. */
export interface VisionTarget {
  /** The vision-capable model definition. */
  readonly model: ModelDefinition;
  /** The connection the vision model lives on. */
  readonly connection: ConnectionConfig | undefined;
}

/**
 * Returns true when the primary model cannot handle images AND the
 * request carries image parts. Pure — no I/O, no side effects.
 */
export function shouldFallback(
  primaryModel: ModelDefinition,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean {
  return (
    !primaryModel.capabilities.imageInput && hasImagePartsMessages(messages)
  );
}

function hasImagePartsMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean {
  return messages.some((message) => hasImageParts(message.content));
}

/**
 * Resolves the vision model + connection for the fallback turn.
 *
 * Resolution order (ADR 0004 constraints 3, 4, 5):
 *   1. If `visionFallback.model` is set, look it up in the catalog
 *      (configured model wins). The connection is
 *      `visionFallback.connection` if set, else the primary's
 *      connection.
 *   2. If `visionFallback.model` is NOT set, auto-search the primary
 *      connection's catalog for the first vision-capable model
 *      (`capabilities.imageInput === true`).
 *   3. If neither path yields a vision model, returns `null` — the
 *      caller surfaces an error to the user.
 *
 * `primaryConnection` is the connection the primary model lives on
 * (`undefined` for the legacy cloud single-connection path).
 */
export function resolveVisionModel(
  primaryModel: ModelDefinition,
  primaryConnection: ConnectionConfig | undefined,
  catalog: readonly ModelDefinition[],
  connections: readonly ConnectionConfig[],
): VisionTarget | null {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const configuredModelId = config.get<string>('visionFallback.model') ?? '';
  const configuredConnectionId =
    config.get<string>('visionFallback.connection') ?? '';

  // Path 1 — explicit model id from settings.
  if (configuredModelId.trim()) {
    const visionModel = findVisionModelById(catalog, configuredModelId.trim());
    if (visionModel) {
      const connection = resolveVisionConnection(
        visionModel,
        configuredConnectionId,
        connections,
        primaryConnection,
      );
      return { model: visionModel, connection };
    }
    // Fall through to auto-search — a stale setting should not block
    // the auto path. The caller's log records both paths.
  }

  // Path 2 — auto-search first vision-capable model on the primary
  // connection's catalog.
  const visionModel = findFirstVisionModelOnConnection(
    catalog,
    primaryConnection,
    primaryModel,
  );
  if (!visionModel) {
    return null;
  }
  const connection = resolveVisionConnection(
    visionModel,
    configuredConnectionId,
    connections,
    primaryConnection,
  );
  return { model: visionModel, connection };
}

function findVisionModelById(
  catalog: readonly ModelDefinition[],
  modelId: string,
): ModelDefinition | undefined {
  return catalog.find(
    (model) =>
      model.id === modelId && model.capabilities.imageInput === true,
  );
}

/**
 * Finds the first vision-capable model on the primary connection. When
 * the primary connection is `undefined` (legacy cloud path), searches
 * the cloud-tagged models. Skips the primary model itself (it is
 * non-vision by the gate).
 */
function findFirstVisionModelOnConnection(
  catalog: readonly ModelDefinition[],
  primaryConnection: ConnectionConfig | undefined,
  primaryModel: ModelDefinition,
): ModelDefinition | undefined {
  const connectionId = primaryConnection?.id ?? primaryModel.connectionId;
  return catalog.find(
    (model) =>
      model.connectionId === connectionId &&
      model.id !== primaryModel.id &&
      model.capabilities.imageInput === true,
  );
}

function resolveVisionConnection(
  visionModel: ModelDefinition,
  configuredConnectionId: string,
  connections: readonly ConnectionConfig[],
  primaryConnection: ConnectionConfig | undefined,
): ConnectionConfig | undefined {
  if (configuredConnectionId.trim()) {
    const configured = findConnection(connections, configuredConnectionId.trim());
    if (configured) {
      return configured;
    }
    // Fall back to the vision model's own connection if the
    // configured connection id is stale.
  }
  // The vision model's own connection is the safest default — its
  // allowedBaseUrls whitelist matches the model's host.
  if (visionModel.connectionId !== 'cloud') {
    return connections.find((c) => c.id === visionModel.connectionId);
  }
  // Legacy cloud path — the model lives on the implicit cloud
  // connection. Use the primary connection (undefined for the cloud
  // single-connection path) so the legacy baseUrl resolution holds.
  return primaryConnection;
}

/** Parameters for `executePassThrough`. */
export interface PassThroughParams {
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
 * Executes the pass-through turn: resolve vision model + connection,
 * build the vision connection's `OllamaClient`, fire the routing
 * disclosure notification, then stream the vision model's response
 * to the user via the same `progress` reporter.
 *
 * Throws when no vision model is found (constraint 9 — no silent
 * degradation; the user gets an actionable error).
 */
export async function executePassThrough(
  params: PassThroughParams,
): Promise<void> {
  const target = resolveVisionModel(
    params.primaryModel,
    params.primaryConnection,
    params.catalog,
    params.connections,
  );
  if (!target) {
    throw new Error(
      'No vision-capable model found for fallback. Configure `ollamaCloud.visionFallback.model` or attach a vision-capable model to the primary connection.',
    );
  }

  const { model: visionModel, connection: visionConnection } = target;

  // Per-connection key isolation (constraint 6 + security invariants).
  // The vision connection's key is used ONLY for the vision fetch.
  const apiKey = visionConnection
    ? await params.authManager.getApiKeyForConnection(visionConnection)
    : await params.authManager.getApiKey();
  if (!apiKey && (!visionConnection || visionConnection.requiresApiKey)) {
    throw new Error(
      'Ollama Cloud API key not configured for the vision fallback connection. Run "Ollama Cloud: Set API Key".',
    );
  }

  // Routing disclosure notification (constraint 8). Never silent.
  // Data-residency disclosure when the vision connection differs
  // from the primary.
  const viaSuffix =
    visionConnection && visionConnection.id !== params.primaryModel.connectionId
      ? ` (via ${visionConnection.label})`
      : '';
  const notification = `Vision fallback: answered by ${visionModel.name} (primary ${params.primaryModel.name} could not handle image)${viaSuffix}`;
  void vscode.window.showInformationMessage(notification);

  // Log — model names + image hash ONLY. NO image data URL (security).
  const imageHash = computeImageHash(params.messages);
  logger.info('vision fallback fired', {
    primaryModel: params.primaryModel.id,
    visionModel: visionModel.id,
    visionConnection: visionConnection?.id ?? 'cloud',
    imageHash,
  });

  // Build the vision connection's OllamaClient. The connection is
  // passed so the SEC-03 per-connection whitelist is enforced at the
  // fetch boundary (`assertBaseUrlAllowedForConnection`).
  const clientBaseUrl = visionConnection
    ? openAiBaseUrl(visionConnection)
    : params.authManager.getBaseUrl();
  const client = new OllamaClient(clientBaseUrl, apiKey ?? '', visionConnection);

  const openaiMessages = convertMessagesToOpenAI(params.messages);
  const requestChars = countOpenAIRequestChars(openaiMessages);

  // Single-hop (constraint 1) — one streamChat call, the same
  // CancellationToken + progress reporter the primary path uses. The
  // user sees the vision model's stream directly.
  await new Promise<void>((resolve, reject) => {
    void client.streamChat(
      {
        model: visionModel.apiModel,
        messages: openaiMessages,
        // Pass-through forwards the user's message + image unchanged.
        // No prompt injection (constraint 7 clarification for B).
        // Tool calling is not part of the fallback turn — the user
        // asked about an image, not for tool orchestration.
      },
      {
        onText: (text: string) => {
          params.progress.report(new vscode.LanguageModelTextPart(text));
        },
        onToolCall: () => {
          // Vision fallback turns do not surface tool calls.
        },
        onUsage: (usage: UsageInfo) => {
          logger.info(
            `vision fallback usage tokens=${usage.totalTokens ?? 0} chars=${requestChars}`,
          );
        },
        onDone: () => resolve(),
        onError: (error: Error) => reject(error),
      },
      params.token,
    );
  });
}

/**
 * Computes a correlation-only hash of the first image part in the
 * request. SHA256 first 16 hex chars. NEVER returns the image data
 * or data URL — this is for log correlation only (security).
 */
function computeImageHash(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  for (const message of messages) {
    for (const part of message.content) {
      if (isImagePart(part)) {
        const data = (part as { data: Uint8Array }).data;
        // Use the global crypto subtle when available; fall back to a
        // length-based hash for the test stub environment. The hash
        // is correlation-only — not a security primitive.
        return sha256ShortHex(data);
      }
    }
  }
  return 'no-image';
}

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== 'object') {
    return false;
  }
  const candidate = part as { mimeType?: unknown; data?: unknown };
  return (
    typeof candidate.mimeType === 'string' &&
    candidate.mimeType.toLowerCase().startsWith('image/') &&
    candidate.data instanceof Uint8Array
  );
}

function sha256ShortHex(data: Uint8Array): string {
  // Node's `node:crypto` is available in the extension host (Node 18+).
  // This is correlation-only — not used for any security decision.
  // The image bytes never leave this function; only the first 16 hex
  // chars of the digest are returned.
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}