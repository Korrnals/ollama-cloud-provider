import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import {
  countOpenAIRequestChars,
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  getMessageText,
  hasImageParts,
} from './convert.js';
import { validateConfiguration } from './configValidator.js';
import { runHealthCheckCommand } from './healthCheck.js';
import { logger } from './logger.js';
import {
  getModelConfigurationSchema,
  resolveModelRequestConfiguration,
  type ModelConfigurationOptions,
  type ModelConfigurationSchema,
} from './modelConfiguration.js';
import {
  ModelCatalog,
  resolveVisionSupport,
  type ModelDefinition,
} from './modelCatalog.js';
import { OllamaClient } from './ollamaClient.js';
import { ResponsesClient } from './responsesClient.js';
import {
  convertToResponsesInput,
  convertToolsToResponses,
} from './convertResponses.js';
import {
  isResponsesKnownUnavailable,
  markResponsesAvailable,
  markResponsesUnavailable,
} from './capabilityCache.js';
import { HttpError } from './retry.js';
import { loadConnections, openAiBaseUrl } from './connections.js';
import { executePassThrough, shouldFallback } from './visionFallback.js';
import type { UsageInfo } from './protocolTypes.js';

const AUTH_REQUIRED_DETAIL =
  'Run Ollama Cloud: Set API Key to configure access.';
const PROVIDER_TOOLTIP = 'Ollama Cloud';

type ModelPickerInformation = vscode.LanguageModelChatInformation & {
  isUserSelectable?: boolean;
  statusIcon?: vscode.ThemeIcon;
  detail?: string;
  tooltip?: string;
  configurationSchema?: ModelConfigurationSchema;
};

export class OllamaCloudChatProvider
  implements vscode.LanguageModelChatProvider
{
  private readonly authManager: AuthManager;
  private readonly modelCatalog: ModelCatalog;
  private readonly onDidChangeLanguageModelChatInformationEmitter =
    new vscode.EventEmitter<void>();
  private charsPerToken = 4;
  private lastCatalogSync = 0;
  private static readonly CATALOG_SYNC_COOLDOWN = 30_000;

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeLanguageModelChatInformationEmitter.event;

  /**
   * Exposed for the Issue 17 smart-notification wiring in `extension.ts`,
   * which needs to check whether an API key is set without going through
   * the command handler. Read-only access.
   */
  get auth(): AuthManager {
    return this.authManager;
  }

  constructor(context: vscode.ExtensionContext) {
    this.authManager = new AuthManager(context);
    this.modelCatalog = new ModelCatalog(this.authManager);

    context.subscriptions.push(
      this.onDidChangeLanguageModelChatInformationEmitter,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('ollamaCloud.apiKey') ||
          event.affectsConfiguration('ollamaCloud.baseUrl') ||
          event.affectsConfiguration('ollamaCloud.connections') ||
          event.affectsConfiguration('ollamaCloud.visionModels') ||
          event.affectsConfiguration('ollamaCloud.allowedBaseUrls')
        ) {
          if (
            event.affectsConfiguration('ollamaCloud.baseUrl') ||
            event.affectsConfiguration('ollamaCloud.connections') ||
            event.affectsConfiguration('ollamaCloud.allowedBaseUrls')
          ) {
            void this.syncModelCatalog();
          }
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
      context.secrets.onDidChange((event) => {
        // Fire on any ollamaCloud.apiKey* secret change so per-connection
        // key updates refresh the model picker status icons.
        if (event.key.startsWith('ollamaCloud.apiKey')) {
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
    );

    // Force VS Code to re-query model information after construction (e.g.
    // after extension update when cached data may lack current schemas).
    queueMicrotask(() =>
      this.onDidChangeLanguageModelChatInformationEmitter.fire(),
    );
  }

  async configureApiKey(): Promise<void> {
    const saved = await this.authManager.promptForApiKey();
    if (saved) {
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
    }
  }

  async clearApiKey(): Promise<void> {
    await this.authManager.deleteApiKey();
    this.onDidChangeLanguageModelChatInformationEmitter.fire();
    vscode.window.showInformationMessage('Ollama Cloud API key removed.');
  }

  async syncModelCatalog(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      now - this.lastCatalogSync < OllamaCloudChatProvider.CATALOG_SYNC_COOLDOWN
    ) {
      return;
    }
    this.lastCatalogSync = now;

    try {
      // Multi-connection refresh when `ollamaCloud.connections` is
      // populated; legacy single-connection refresh otherwise. The
      // legacy path preserves the 192 existing tests' behaviour.
      const connections = loadConnections();
      const result =
        connections.length > 1 ||
          (connections.length === 1 && connections[0]!.type !== 'cloud')
          ? await this.modelCatalog.refreshForConnections(connections)
          : await this.modelCatalog.refresh();
      logger.info(
        `Synced model list. changed=${result.changed} count=${result.count} connections=${connections.length}`,
      );
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
    } catch (error) {
      logger.error('Failed to sync model list.', error);
    }
  }

  /**
   * Read-only access to the catalog list. Exposed for the vision
   * fallback command handlers (QuickPick of vision-capable models).
   */
  modelCatalogList(): readonly ModelDefinition[] {
    return this.modelCatalog.list();
  }

  async showRegisteredModels(): Promise<void> {
    const hasApiKey = await this.authManager.hasApiKey();
    const models = this.modelCatalog.list();

    logger.info(
      `Registered Ollama Cloud models. count=${models.length} hasApiKey=${hasApiKey}`,
    );
    for (const model of models) {
      logger.info(
        `model name="${model.name}" id="${model.id}" apiModel="${model.apiModel}" maxInputTokens=${model.maxInputTokens} maxOutputTokens=${model.maxOutputTokens}`,
      );
    }
    logger.show();

    void vscode.window.showInformationMessage(
      'Ollama Cloud model list written to the output log.',
    );
  }

  async checkConnection(): Promise<void> {
    // Issue 15 — delegate to the healthCheck module. It performs the
    // whitelist + API-key + reachability checks and shows the result
    // notification. This method is the command handler body.
    await runHealthCheckCommand(this.authManager);
  }

  /**
   * Command handler for `ollamaCloud.refreshModels` — force-syncs the
   * model catalog with a progress notification, bypassing the 30s
   * cooldown. After the sync completes, shows the model count so the
   * user sees the result of the refresh.
   */
  async refreshModelsCommand(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Ollama Cloud: Refreshing models...',
        cancellable: false,
      },
      () => this.syncModelCatalog(true),
    );
    const count = this.modelCatalog.list().length;
    vscode.window.showInformationMessage(
      `Ollama Cloud: ${count} models available.`,
    );
  }

  async validateConfig(): Promise<void> {
    // Issue 16 — delegate to the configValidator module. It runs the
    // full validation suite (baseUrl whitelist, API key, reachability,
    // requestTimeoutMs, maxRetries) and shows the summary notification.
    await validateConfiguration(this.authManager);
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasApiKey = await this.authManager.hasApiKey();
    return this.modelCatalog
      .list()
      .map((model) => toChatInformation(model, hasApiKey));
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const model = this.modelCatalog.get(modelInfo.id);
    if (!model) {
      throw new Error(`Unknown Ollama Cloud model: ${modelInfo.id}`);
    }

    // Resolve the connection for this model. Cloud connection models
    // keep the legacy single-connection path (backward compatibility —
    // the 192 existing tests exercise this branch). Non-cloud
    // connection models resolve their connection via `connectionId`.
    const connections = loadConnections();
    // ADR 0006 — resolve the cloud connection object too (not just
    // non-cloud). Cloud models keep the legacy apiKey path
    // (`getApiKey()` + `connection = undefined` semantics for the
    // 192 existing tests), but the dispatch block below reads
    // `connection?.preferredEndpoint` to decide between
    // `/v1/responses` and `/chat/completions`. Without the cloud
    // connection object here, `preferredEndpoint: 'chat'` set on the
    // cloud connection is invisible to dispatch and every cloud
    // request routes to `/v1/responses` regardless of the override.
    // `apiKeyForCloud` keeps the legacy resolution; `connection` is
    // only used for endpoint selection + baseUrl (which already
    // fall back to `getBaseUrl()` when undefined).
    const cloudConnection =
      model.connectionId === 'cloud'
        ? connections.find((c) => c.id === model.connectionId)
        : undefined;
    const connection =
      model.connectionId === 'cloud'
        ? undefined
        : connections.find((c) => c.id === model.connectionId);

    // API key resolution — cloud connection uses the legacy
    // `getApiKey()` (SecretStorage + config + env fallback). Non-cloud
    // connections use `getApiKeyForConnection()` (SecretStorage only,
    // keyed `ollamaCloud.apiKey.<connectionId>`). Connections with
    // `requiresApiKey === false` (local Ollama) skip the key entirely.
    const apiKey = connection
      ? await this.authManager.getApiKeyForConnection(connection)
      : await this.authManager.getApiKey();
    if (!apiKey && (!connection || connection.requiresApiKey)) {
      throw new Error(
        'Ollama Cloud API key not configured. Run "Ollama Cloud: Set API Key".',
      );
    }

    // Vision gate — SEC-03 complement: do NOT silently drop image
    // attachments sent to a text-only model. Two outcomes:
    //   - Fallback ENABLED (ADR 0004): when the primary model cannot
    //     handle the image, route the turn to a vision-capable model
    //     via `executePassThrough` (single-hop pass-through). The vision
    //     model answers the user directly; the primary is not involved.
    //   - Fallback DISABLED: throw a clear error so the user sees why
    //     the request failed and can switch to a vision-capable model
    //     (constraint 9 — no silent degradation; current behaviour).
    const requestHasImages = messages.some((m) => hasImageParts(m.content));
    const connectionVisionPatterns = connection?.visionModels ?? [];
    const supportsImages = resolveVisionSupport(model, connectionVisionPatterns);
    if (requestHasImages && !supportsImages) {
      const fallbackEnabled = vscode.workspace
        .getConfiguration('ollamaCloud')
        .get<boolean>('visionFallback.enabled', false);
      if (fallbackEnabled && shouldFallback(model, messages)) {
        // ADR 0004 — pass-through. The vision model streams to the
        // user via the same progress reporter + CancellationToken.
        // Returns from here; the primary path below is not reached.
        return await executePassThrough({
          primaryModel: model,
          primaryConnection: connection ?? cloudConnection,
          messages,
          options,
          progress,
          token,
          authManager: this.authManager,
          catalog: this.modelCatalog.list(),
          connections,
        });
      }
      throw new Error(
        `${model.name} does not support image input. Select a model with vision capability before attaching images.`,
      );
    }

    const clientBaseUrl = connection
      ? openAiBaseUrl(connection)
      : this.authManager.getBaseUrl();
    const client = new OllamaClient(clientBaseUrl, apiKey ?? '', connection);
    const modelOptions = options as ModelConfigurationOptions;
    const requestConfiguration = resolveModelRequestConfiguration(
      model,
      modelOptions,
    );
    const openaiMessages = convertMessagesToOpenAI(messages);
    const requestChars = countOpenAIRequestChars(openaiMessages);

    // ADR 0006 — endpoint selection. Cloud connections prefer
    // `/v1/responses` (structured reasoning, typed events, first-class
    // tool calling). Local Ollama only implements `/chat/completions`,
    // so local connections route there directly. `preferredEndpoint:
    // 'chat'` is an explicit user override. The capability cache
    // short-circuits the `/v1/responses` attempt once a prior 404 has
    // been memoized for the connection (avoids the per-request 404
    // round-trip). No mid-stream fallback — POST is non-idempotent and
    // a retry would bill twice (ADR 0001/0005).
    // Cloud models keep `connection = undefined` for the legacy apiKey
    // path, so read `preferredEndpoint` / `type` / `id` from either the
    // resolved non-cloud connection or the cloud connection object.
    const endpointConnection = connection ?? cloudConnection;
    const preferredEndpoint = endpointConnection?.preferredEndpoint ?? 'auto';
    const isLocal = endpointConnection?.type === 'local';
    const connectionId = endpointConnection?.id ?? 'cloud';
    const useResponses =
      !isLocal &&
      preferredEndpoint !== 'chat' &&
      !isResponsesKnownUnavailable(connectionId);

    if (useResponses) {
      try {
        const responsesClient = new ResponsesClient(
          clientBaseUrl,
          apiKey ?? '',
          connection,
        );
        const { input, instructions } = convertToResponsesInput(messages);
        const responsesTools = convertToolsToResponses(options.tools);
        await this.runStream(
          (callbacks) =>
            responsesClient.streamResponses(
              {
                model: model.apiModel ?? model.id,
                input,
                ...(instructions !== undefined ? { instructions } : {}),
                ...(responsesTools !== undefined ? { tools: responsesTools } : {}),
                tool_choice: resolveToolChoice(options.toolMode, options.tools),
                extraBody: requestConfiguration.openaiBody,
              },
              callbacks,
              token,
            ),
          progress,
          model,
          requestChars,
          () => markResponsesAvailable(connectionId),
        );
        return; // success — no fallback needed
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          markResponsesUnavailable(connectionId);
          logger.info(
            `Falling back to /chat/completions (/v1/responses returned 404) for connection "${connectionId}"`,
          );
          // fall through to /chat/completions below
        } else {
          throw error; // non-404 — surface, no fallback (no double billing)
        }
      }
    }

    // /chat/completions path (fallback for cloud + 404, primary for
    // local and `preferredEndpoint: 'chat'`). Unchanged.
    await this.runStream(
      (callbacks) =>
        client.streamChat(
          {
            model: model.apiModel,
            messages: openaiMessages,
            tools: convertToolsToOpenAI(options.tools),
            tool_choice: resolveToolChoice(options.toolMode, options.tools),
            extraBody: requestConfiguration.openaiBody,
          },
          callbacks,
          token,
        ),
      progress,
      model,
      requestChars,
      undefined,
    );
  }

  async provideTokenCount(
    _modelInfo: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const rawText = getMessageText(text);
    return Math.max(1, Math.ceil(rawText.length / this.charsPerToken));
  }

  private updateTokenEstimate(requestChars: number, usage: UsageInfo): void {
    if (!requestChars || !usage.inputTokens) {
      return;
    }

    const observed = requestChars / usage.inputTokens;
    this.charsPerToken = this.charsPerToken * 0.7 + observed * 0.3;
  }

  /**
   * ADR 0006 — runs a streaming client (`streamChat` or
   * `streamResponses`) and resolves when the client calls `onDone`,
   * rejects when it calls `onError`. Both clients use the same
   * `StreamCallbacks` interface (see `protocolTypes.ts`) and never
   * resolve their returned promise with a value — termination is
   * signalled via the callbacks. This helper bridges that callback
   * contract to `async`/`await` at the call site.
   *
   * `onSuccess` runs after `onDone` fires and BEFORE the promise
   * resolves — used by the `/v1/responses` path to memoize
   * capability (`markResponsesAvailable`) only on a clean completion,
   * not on a fallback that re-throws.
   *
   * Structured reasoning: `onThinking` → `LanguageModelThinkingPart`
   * when the API is present (VS Code 1.103+), otherwise the part is
   * silently dropped — the `/chat/completions` client never emits
   * `onThinking`, so this only fires on the `/v1/responses` path.
   */
  private async runStream(
    invoke: (
      callbacks: import('./protocolTypes.js').StreamCallbacks,
    ) => Promise<void>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    model: ModelDefinition,
    requestChars: number,
    onSuccess: (() => void) | undefined,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      void invoke({
        onText: (text: string) => {
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onThinking: (text: string) => {
          const thinkingPart = createThinkingPart(text);
          if (thinkingPart) {
            progress.report(thinkingPart);
          }
        },
        onToolCall: (toolCall: {
          id: string;
          name: string;
          input: Record<string, unknown>;
        }) => {
          progress.report(
            new vscode.LanguageModelToolCallPart(
              toolCall.id,
              toolCall.name,
              toolCall.input,
            ),
          );
        },
        onUsage: (usage: UsageInfo) => {
          this.updateTokenEstimate(requestChars, usage);
          logger.info(formatUsageLog(model.id, usage));
        },
        onDone: () => {
          onSuccess?.();
          resolve();
        },
        onError: (error: Error) => reject(error),
      }).catch((error: unknown) => {
        // Safety net: if the client rejects its own promise instead
        // of calling onError (shouldn't happen, but defence-in-depth),
        // surface it as a rejection so the caller's try/catch fires.
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

function toChatInformation(
  model: ModelDefinition,
  hasApiKey: boolean,
): vscode.LanguageModelChatInformation {
  const configurationSchema = getModelConfigurationSchema(model);

  // Origin label prefix — `Cloud:`, `Local:`, `VPS:`, `custom:`. Cloud
  // connection keeps the bare model name for backward compatibility
  // (existing test assertions check `name` without a prefix). Non-
  // cloud connections prepend the origin label so the picker shows
  // which connection a model came from.
  const name =
    model.origin === 'Cloud'
      ? model.name
      : `${model.origin}:${model.name}`;

  return {
    id: model.id,
    name,
    family: model.family,
    version: model.version,
    detail: model.origin === 'Cloud' ? PROVIDER_TOOLTIP : model.origin,
    tooltip: hasApiKey
      ? PROVIDER_TOOLTIP
      : `${PROVIDER_TOOLTIP}\n${AUTH_REQUIRED_DETAIL}`,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: {
      imageInput: model.capabilities.imageInput,
      toolCalling: model.capabilities.toolCalling,
    },
    isUserSelectable: true,
    statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
    ...(configurationSchema ? { configurationSchema } : {}),
  } as ModelPickerInformation;
}

function resolveToolChoice(
  toolMode: vscode.LanguageModelChatToolMode,
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): 'auto' | 'required' | 'none' | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return toolMode === vscode.LanguageModelChatToolMode.Required
    ? 'required'
    : 'auto';
}

function formatUsageLog(modelId: string, usage: UsageInfo): string {
  const parts = [`[${modelId}]`];
  if (usage.inputTokens !== undefined) {
    parts.push(`input=${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`output=${usage.outputTokens}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`total=${usage.totalTokens}`);
  }
  return parts.join(' ');
}

function createThinkingPart(
  text: string,
): vscode.LanguageModelResponsePart {
  // ADR 0006 Phase 3 — structured reasoning. Prefer
  // `LanguageModelThinkingPart` when the API is present (VS Code
  // 1.103+). On older VS Code versions where the class is absent,
  // fall back to `LanguageModelTextPart` so the reasoning content
  // is still surfaced to the user rather than silently dropped.
  const vscodeWithThinking = vscode as typeof vscode & {
    LanguageModelThinkingPart?: new (
      value: string,
    ) => vscode.LanguageModelResponsePart;
  };

  if (typeof vscodeWithThinking.LanguageModelThinkingPart === 'function') {
    return new vscodeWithThinking.LanguageModelThinkingPart(text);
  }

  return new vscode.LanguageModelTextPart(text);
}
