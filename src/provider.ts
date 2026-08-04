import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import {
  countOpenAIRequestChars,
  convertMessagesToOpenAI,
  convertMessagesToNative,
  convertToolsToOpenAI,
  convertToolsToNative,
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
  convertOpenAIMessagesToResponsesInput,
  convertOpenAIToolsToResponses,
} from './convertResponses.js';
import {
  clearCapabilityCache,
  isChatKnownUnavailable,
  isNativeChatKnownUnavailable,
  isResponsesKnownUnavailable,
  markChatAvailable,
  markChatUnavailable,
  markNativeChatAvailable,
  markNativeChatUnavailable,
  markResponsesAvailable,
  markResponsesUnavailable,
} from './capabilityCache.js';
import { HttpError, MidStreamError } from './retry.js';
import {
  loadConnections,
  nativeBaseUrl,
  openAiBaseUrl,
} from './connections.js';
import type { ConnectionConfig } from './connections.js';
import { executePassThrough, shouldFallback } from './visionFallback.js';
import type { OpenAICompatibleTool, UsageInfo } from './protocolTypes.js';
import { filterContext, type ContextFilterLevel } from './contextFilter.js';

const AUTH_REQUIRED_DETAIL =
  'Run Ollama Cloud: Set API Key to configure access.';
const PROVIDER_TOOLTIP = 'Ollama Cloud';

/**
 * Issue #41 — Strand 2. Resolves the effective endpoint label shown in
 * the model picker tooltip and logged on config change.
 *
 *   - local connection        → `/chat/completions (local)`
 *   - explicit `responses`    → `/v1/responses`
 *   - explicit `chat`         → `/chat/completions`
 *   - explicit `native`       → `/api/chat (native)`
 *   - `auto` (default)        → `auto (resolves to /v1/responses)` when
 *     the global `preferredEndpoint` is the default `'responses'`,
 *     otherwise `auto (resolves to /chat/completions)`.
 *
 * Phase 1 (2026-08-03 endpoint routing) — `'native'` is a third
 * explicit option. `'auto'` still resolves to `'responses'` or
 * `'chat'` (NOT `'native'`), so the default behaviour is unchanged.
 *
 * The label is deliberately short and contains no host or auth material
 * so it is safe to surface in a tooltip and in the output log.
 */
function resolveEndpointLabel(connection: ConnectionConfig | undefined): string {
  if (!connection || connection.type === 'local') {
    return '/chat/completions (local)';
  }
  const preferred = connection.preferredEndpoint ?? 'auto';
  if (preferred === 'responses') {
    return '/v1/responses';
  }
  if (preferred === 'chat') {
    return '/chat/completions';
  }
  if (preferred === 'native') {
    return '/api/chat (native)';
  }
  // auto — resolves against the global setting.
  const globalPreferred = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<'responses' | 'chat' | 'native'>('preferredEndpoint', 'responses');
  return `auto (resolves to ${globalPreferred === 'chat' ? '/chat/completions' : globalPreferred === 'native' ? '/api/chat (native)' : '/v1/responses'})`;
}

/**
 * Issue #40 — builds the explicit-mode 404 error thrown when the user
 * explicitly chose `primaryEndpoint` and that endpoint returned 404.
 * The message names the failing endpoint, the connection, and the two
 * remediation paths (switch to `auto` for automatic fallback, or
 * switch to the other explicit endpoint). Surfaced as a
 * `LanguageModelError` so VS Code presents it consistently to the
 * chat participant that invoked the model.
 */
function endpointExplicitUnavailableError(
  primaryEndpoint: 'responses' | 'chat' | 'native',
  connectionId: string,
): vscode.LanguageModelError {
  if (primaryEndpoint === 'responses') {
    return vscode.LanguageModelError.NotFound(
      `Endpoint /v1/responses returned 404 for connection "${connectionId}". You have explicitly chosen this endpoint. Set "ollamaCloud.preferredEndpoint" to "auto" for automatic fallback, or switch to "chat".`,
    );
  }
  if (primaryEndpoint === 'native') {
    return vscode.LanguageModelError.NotFound(
      `Endpoint /api/chat (native) returned 404 for connection "${connectionId}". You have explicitly chosen this endpoint. Set "ollamaCloud.preferredEndpoint" to "auto" for automatic fallback, or switch to "chat" or "responses".`,
    );
  }
  return vscode.LanguageModelError.NotFound(
    `Endpoint /chat/completions returned 404 for connection "${connectionId}". You have explicitly chosen this endpoint. Set "ollamaCloud.preferredEndpoint" to "auto" for automatic fallback, or switch to "responses".`,
  );
}

/**
 * Phase 2 — classifies an error from `runStream` into a human-readable
 * `vscode.LanguageModelError` so VS Code shows the user a clear message,
 * not a raw stack trace. The raw error (with stack) is logged in
 * `runStream`'s `onError` handler before it reaches here.
 */
function classifyStreamError(error: unknown): Error {
  if (error instanceof MidStreamError) {
    return new Error(`Ollama Cloud: ${error.serverMessage}`);
  }
  if (error instanceof HttpError) {
    // Surface the server's actual error message when present (extracted
    // from the `{"error":"..."}` body by `extractErrorMessage`). Fall
    // back to a generic Russian message only when the server gave no
    // detail. Avoid duplicating the HTTP status prefix.
    const serverMsg =
      error.message && !error.message.startsWith('HTTP ')
        ? error.message
        : '';
    switch (error.status) {
      case 402:
        return vscode.LanguageModelError.Blocked(
          serverMsg
            ? `Ollama Cloud: ${serverMsg}`
            : 'Ollama Cloud: Payment Required (HTTP 402) — проверьте, что модель доступна на вашем тарифе, либо уменьшите контекст.',
        );
      case 403:
        return vscode.LanguageModelError.Blocked(
          serverMsg
            ? `Ollama Cloud: ${serverMsg}`
            : 'Ollama Cloud: Forbidden (HTTP 403) — авторизация отклонена сервером.',
        );
      case 429:
        return vscode.LanguageModelError.Blocked(
          serverMsg
            ? `Ollama Cloud: ${serverMsg}`
            : 'Ollama Cloud: Rate limit exceeded (HTTP 429) — попробуйте позже.',
        );
      case 404:
        return vscode.LanguageModelError.NotFound(
          serverMsg
            ? `Ollama Cloud: ${serverMsg}`
            : 'Ollama Cloud: Not Found (HTTP 404) — модель или эндпоинт недоступен.',
        );
      default:
        if (error.status >= 500) {
          return new Error(
            serverMsg
              ? `Ollama Cloud: Server error (HTTP ${error.status}) — ${serverMsg}`
              : `Ollama Cloud: Server error (HTTP ${error.status}) — проблема на стороне Ollama Cloud.`,
          );
        }
        return new Error(`Ollama Cloud: HTTP ${error.status} — ${error.message}`);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * ADR 0007 — resolves the `/v1/responses` `tools[]` array from the
 * filter state. When the context filter ran (`filterReport !==
 * undefined`, i.e. `safe`/`aggressive`), the filter produced a
 * filtered `OpenAICompatibleTool[]` (`filteredTools`) — convert it
 * directly to the `/v1/responses` tool schema via
 * `convertOpenAIToolsToResponses` (no VS Code ↔ OpenAI round-trip,
 * symmetric with `convertOpenAIMessagesToResponsesInput` for
 * messages). When the filter did NOT run (`off` fast path,
 * `filterReport === undefined`), convert the ORIGINAL VS Code
 * `options.tools` via `convertToolsToResponses` — the 375-test
 * regression path is untouched.
 *
 * `filteredTools` is the post-filter OpenAI-format tool list (the
 * filter dedupes by `function.name` and may drop entries). At `off`,
 * `filteredTools` holds the unfiltered `convertToolsToOpenAI` output —
 * but we still take the `options.tools` branch because the
 * `filterReport === undefined` signal means "use the original
 * conversion path", keeping the off-path byte-identical to pre-#39.
 */
function resolveResponsesTools(
  filterReport: ReturnType<typeof filterContext>['report'] | undefined,
  filteredTools: readonly OpenAICompatibleTool[] | undefined,
  originalTools: readonly vscode.LanguageModelChatTool[] | undefined,
): ReturnType<typeof convertOpenAIToolsToResponses> {
  if (filterReport !== undefined) {
    return convertOpenAIToolsToResponses(filteredTools);
  }
  return convertToolsToResponses(originalTools);
}

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
        // Issue #40 — `preferredEndpoint` drives the explicit-vs-auto
        // endpoint decision. The capability cache memoizes per-endpoint
        // availability keyed by connection id; a stale entry from the
        // previous setting would short-circuit the new choice (and in
        // explicit mode now *throws* instead of silently routing). Clear
        // the cache so the next request re-probes both endpoints live.
        // Per-connection `preferredEndpoint` lives under
        // `ollamaCloud.connections` and is already covered by the
        // catalog-sync + emitter branch above; the global scalar key is
        // the only one that needs an explicit cache clear here.
        if (event.affectsConfiguration('ollamaCloud.preferredEndpoint')) {
          clearCapabilityCache();
          // Issue #41 — Strand 2: log the new effective endpoint per
          // connection so a config change is visible in the output log.
          // One line per connection — no host, no auth material.
          for (const conn of loadConnections()) {
            logger.info(
              `Endpoint changed: connection="${conn.id}" endpoint=${resolveEndpointLabel(conn)}`,
            );
          }
          // Issue #41 — must-fix: fire the information emitter so VS Code
          // re-queries `provideLanguageModelChatInformation` and the
          // model picker tooltip refreshes. Without this, changing only
          // the global `preferredEndpoint` setting leaves the
          // `Endpoint: auto (resolves to ...)` tooltip line stale until
          // some other event (catalog sync, apiKey change) fires the
          // emitter. Matches the pattern used by the
          // baseUrl/connections/apiKey branch above.
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
    // Issue #41 — Strand 2: pass the model's connection so the tooltip
    // can show the effective endpoint. Resolved once per call. (Review
    // fix Finding 5: the previous `?? (cloud ? find cloud : undefined)`
    // fallback was fully redundant — the `find` already locates `cloud`
    // when `model.connectionId === 'cloud'`.)
    const connections = loadConnections();
    return this.modelCatalog
      .list()
      .map((model) => {
        const connection = connections.find((c) => c.id === model.connectionId);
        return toChatInformation(model, hasApiKey, connection);
      });
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

    try {
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

      // ADR 0006 — endpoint selection deferred to the block below (it
      // needs `endpointConnection` + `globalConfig`). ADR 0007 context
      // filter is resolved in that same block so it can reuse
      // `endpointConnection` + `globalConfig` without recomputing them.
      // `requestChars` is computed AFTER the filter runs so it reflects
      // the FILTERED payload (used for the convert audit line + the
      // token estimator).
      let filteredMessages = openaiMessages;
      let filteredTools = convertToolsToOpenAI(options.tools);
      let filterReport: ReturnType<typeof filterContext>['report'] | undefined;
      let requestChars = 0;

      // ADR 0006 — endpoint selection. The user picks a primary endpoint
      // via `ollamaCloud.preferredEndpoint` (global setting, default
      // `'responses'`). Per-connection `preferredEndpoint` overrides
      // this: `'responses'`/`'chat'` are explicit; `'auto'` inherits the
      // global setting.
      //
      // Issue #40 — fallback policy. When the user EXPLICITLY chose the
      // primary endpoint (per-connection `'responses'`/`'chat'`, OR a
      // global `preferredEndpoint` the user actually configured rather
      // than the default), a 404 from that endpoint does NOT silently
      // fall back. The provider throws a clear, actionable error so the
      // user knows their explicit choice is unsupported by this
      // connection and can switch endpoints or opt into `auto`. When the
      // effective choice is `'auto'` (the default, or a per-connection
      // `'auto'` inheriting a default global), the prior fallback +
      // log-warning behaviour is preserved.
      //
      // The OTHER endpoint is the automatic fallback on HTTP 404:
      //   primary=responses → fallback=chat (and vice versa).
      // Local Ollama always uses /chat/completions (no /v1/responses).
      //
      // The capability cache short-circuits the primary attempt once a
      // prior 404 has been memoized for the connection. No mid-stream
      // fallback — POST is non-idempotent and a retry would bill twice
      // (ADR 0001/0005). The cache is intentionally NOT bypassed for
      // explicit mode: if an explicit endpoint is already known
      // unavailable (memoized from a prior 404 in this session), the
      // explicit-mode error must still fire — but it fires from the
      // cache short-circuit path, not from a fresh 404 round-trip. See
      // `endpointExplicitUnavailableError` below.
      const endpointConnection = connection ?? cloudConnection;
      const connectionPreferred = endpointConnection?.preferredEndpoint ?? 'auto';
      const isLocal = endpointConnection?.type === 'local';
      const connectionId = endpointConnection?.id ?? 'cloud';

      // Resolve the effective primary endpoint AND whether the choice is
      // explicit. Explicit = per-connection `'responses'`/`'chat'` (always
      // an override) OR a global `preferredEndpoint` the user actually
      // configured (detected via `inspect()` — `globalValue`/`workspaceValue`
      // set, vs. only `defaultValue`). `'auto'` per-connection inherits
      // the global explicitness.
      const globalConfig = vscode.workspace.getConfiguration('ollamaCloud');
      const globalInspection = globalConfig.inspect<'responses' | 'chat' | 'native' | 'auto'>('preferredEndpoint');
      const globalPreferredExplicit =
        globalInspection?.globalValue !== undefined ||
        globalInspection?.workspaceValue !== undefined ||
        globalInspection?.workspaceFolderValue !== undefined;
      // Phase 2 (2026-08-03 endpoint routing) — `auto` for cloud now
      // resolves to `native` (the documented canonical endpoint per
      // docs.ollama.com/cloud). `auto` for local stays `chat` (compat).
      // Users can still explicitly choose `responses`/`chat`/`native` to
      // override. The capability cache + 404 fallback (native → chat)
      // covers connections that don't support `/api/chat`.
      const globalPreferred = globalConfig.get<'responses' | 'chat' | 'native'>(
        'preferredEndpoint',
        'native',
      );
      const isPreferredEndpointExplicit =
        !isLocal &&
        (connectionPreferred === 'responses' ||
          connectionPreferred === 'chat' ||
          connectionPreferred === 'native' ||
          (connectionPreferred === 'auto' && globalPreferredExplicit));

      const primaryEndpoint: 'responses' | 'chat' | 'native' =
        isLocal
          ? 'chat'
          : connectionPreferred === 'auto'
            ? globalPreferred
            : connectionPreferred;

      // ADR 0007 — resolve the effective context-filter level and run
      // the filter (only at `safe`/`aggressive` — `off` is a fast path
      // that skips `filterContext` entirely, preserving zero overhead
      // when the filter is disabled). Per-connection `contextFilter.level`
      // overrides the global; `'auto'`/`undefined` inherit the global
      // (mirrors `preferredEndpoint`). The filter is pure + endpoint-
      // agnostic: it runs once on the OpenAI-format `openaiMessages` and
      // the filtered output feeds BOTH endpoints — `/chat/completions`
      // via `filteredMessages` directly, `/v1/responses` via
      // `convertOpenAIMessagesToResponsesInput` (shapes the filtered
      // OpenAI messages into `/v1/responses` input without a VS Code ↔
      // OpenAI round-trip). `requestChars` is computed AFTER the filter
      // so it reflects the filtered payload (drives the convert audit
      // line + the token estimator).
      const connectionContextFilter = endpointConnection?.contextFilter ?? 'auto';
      const globalContextFilter = globalConfig.get<'off' | 'safe' | 'aggressive'>(
        'contextFilter.level',
        'off',
      );
      const effectiveFilterLevel: ContextFilterLevel =
        connectionContextFilter === 'auto'
          ? globalContextFilter
          : connectionContextFilter;
      if (effectiveFilterLevel !== 'off') {
        const filterResult = filterContext({
          messages: openaiMessages,
          tools: filteredTools,
          level: effectiveFilterLevel,
          maxInputTokens: model.maxInputTokens,
        });
        filteredMessages = filterResult.messages;
        filteredTools = filterResult.tools;
        filterReport = filterResult.report;
      }
      requestChars = countOpenAIRequestChars(filteredMessages);

      // Issue #41 — Strand 3.1: convert-path redundancy audit. Verdict
      // (verified 2026-07-29): NO redundancy in either converter.
      //   - `convertMessagesToOpenAI`: system prompt lives in exactly
      //     one `role:system` message; tool definitions go only in the
      //     top-level `tools` array (via `convertToolsToOpenAI`), never
      //     inlined into a message; instructions are not a `/chat/
      //     completions` concept so there is no `instructions`+message
      //     duplication vector.
      //   - `convertToResponsesInput`: the FIRST system message is
      //     hoisted to top-level `instructions`; subsequent system
      //     messages are dropped (logged). Tool definitions go only in
      //     the top-level `tools` array (via `convertToolsToResponses`).
      // No content is sent twice. The audit verdict is recorded in this
      // comment (review fix Finding 6: the per-request `convert audit:`
      // log line was removed — the verdict is static and `requestChars`
      // is already carried by the `Endpoint selected` line below, so the
      // per-request line was pure noise on the output channel).

      // ADR 0007 — context-filter log line. Emitted at `safe` /
      // `aggressive` only (NOT `off` — no logging at `off` per ADR).
      // The log carries char counts + drop counts ONLY — no message
      // content (sensitive-data policy: the filter log is a telemetry
      // line, not a content dump). Per-class diagnostics follow only
      // when the count for that class is non-zero (no "dropped 0"
      // noise), mirroring the Issue #41 convert-path diagnostic style.
      if (filterReport !== undefined) {
        const before = filterReport.beforeChars;
        const after = filterReport.afterChars;
        const saved =
          before === 0 ? 0 : Math.round(((before - after) / before) * 100);
        logger.info(
          `Context filter: level=${filterReport.level} before=${before}chars after=${after}chars saved=${saved}% (${filterReport.droppedMessages} messages dropped, ${filterReport.droppedTools} tools dropped, ${filterReport.mergedMessages} merged, ${filterReport.truncatedMessages} truncated)`,
        );
        if (filterReport.droppedMessages > 0) {
          logger.info(
            `Context filter: dropped ${filterReport.droppedMessages} duplicate messages`,
          );
        }
        if (filterReport.mergedMessages > 0) {
          logger.info(
            `Context filter: merged ${filterReport.mergedMessages} similar pairs`,
          );
        }
        if (filterReport.truncatedMessages > 0) {
          logger.info(
            `Context filter: truncated ${filterReport.truncatedMessages} oldest messages`,
          );
        }
        if (filterReport.droppedTools > 0) {
          logger.info(
            `Context filter: dropped ${filterReport.droppedTools} duplicate tools`,
          );
        }
        if (filterReport.strippedMetadataFields > 0) {
          logger.info(
            `Context filter: stripped metadata from ${filterReport.strippedMetadataFields} fields`,
          );
        }
      }

      logger.info(
        `Endpoint selected: primary=${primaryEndpoint}, explicit=${isPreferredEndpointExplicit}, connection="${connectionId}", isLocal=${isLocal}, apiModel="${model.apiModel ?? model.id}", requestChars=${requestChars}`,
      );

      // Issue #40 — capability-cache short-circuit guard for explicit
      // mode. When the user explicitly chose `primaryEndpoint` AND the
      // capability cache already memoized that endpoint as unavailable
      // (a prior 404 in this session), the explicit-mode contract
      // requires the actionable error — NOT a silent detour to the other
      // endpoint. Without this guard, the cache would skip the primary
      // `if` block and execution would fall through to the other
      // endpoint, silently routing around the user's explicit choice.
      // The cache itself is NOT bypassed (per task spec point 6); the
      // guard reads it and translates "known unavailable + explicit"
      // into the same error a live 404 would produce.
      if (
        isPreferredEndpointExplicit &&
        primaryEndpoint === 'responses' &&
        isResponsesKnownUnavailable(connectionId)
      ) {
        logger.info(
          `Explicit /v1/responses cached-unavailable for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
        );
        throw endpointExplicitUnavailableError('responses', connectionId);
      }
      if (
        isPreferredEndpointExplicit &&
        primaryEndpoint === 'chat' &&
        isChatKnownUnavailable(connectionId)
      ) {
        logger.info(
          `Explicit /chat/completions cached-unavailable for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
        );
        throw endpointExplicitUnavailableError('chat', connectionId);
      }
      // Phase 1 — native short-circuit guard (mirrors the chat one).
      if (
        isPreferredEndpointExplicit &&
        primaryEndpoint === 'native' &&
        isNativeChatKnownUnavailable(connectionId)
      ) {
        logger.info(
          `Explicit /api/chat (native) cached-unavailable for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
        );
        throw endpointExplicitUnavailableError('native', connectionId);
      }

      // Phase 1 (2026-08-03 endpoint routing) — native `/api/chat`
      // path. Opt-in only: triggered by explicit `preferredEndpoint:
      // 'native'` (per-connection or global). `auto` never resolves
      // to `native`, so this block is only reached when the user
      // explicitly chose native. On 404 with explicit mode, throw the
      // actionable error (no silent fallback). The native path is
      // reached BEFORE the responses/chat blocks so an explicit
      // `native` choice never accidentally routes to `/v1/responses`
      // or `/chat/completions` first.
      // Responses API path — restored from v0.7.3 (accidentally removed in v0.8.0
      // endpoint routing rewrite). Uses compat schema (thinking: {type}, not think: true).
      if (primaryEndpoint === 'responses' && !isResponsesKnownUnavailable(connectionId)) {
        try {
          const responsesClient = new ResponsesClient(
            clientBaseUrl,
            apiKey ?? '',
            connection,
          );
          // ADR 0007 — `/v1/responses` consumes the FILTERED payload.
          // When the filter ran (`filterReport !== undefined`), shape
          // the filtered `OpenAICompatibleMessage[]` directly into
          // `/v1/responses` input via `convertOpenAIMessagesToResponsesInput`
          // (no VS Code ↔ OpenAI round-trip — keeps the filter
          // endpoint-agnostic and avoids lossy re-conversion). When the
          // filter did NOT run (`off` fast path), use the original
          // `convertToResponsesInput` on the VS Code `messages` (the
          // 375-test regression path is untouched).
          const { input, instructions } =
            filterReport !== undefined
              ? convertOpenAIMessagesToResponsesInput(filteredMessages)
              : convertToResponsesInput(messages);
          const responsesTools = resolveResponsesTools(filterReport, filteredTools, options.tools);
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
            // Issue #40 — explicit choice: do NOT silently fall back.
            // Surface an actionable error so the user knows their
            // explicit endpoint is unsupported by this connection.
            if (isPreferredEndpointExplicit) {
              logger.info(
                `Explicit /v1/responses 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
              );
              throw endpointExplicitUnavailableError('responses', connectionId);
            }
            logger.info(
              `Auto-mode fallback: /v1/responses returned 404 for connection "${connectionId}" — retrying on /chat/completions`,
            );
            // fall through to /chat/completions below
          } else {
            throw error; // non-404 — surface, no fallback (no double billing)
          }
        }
      }

      if (primaryEndpoint === 'native' && !isNativeChatKnownUnavailable(connectionId)) {
        try {
          // When `endpointConnection` is defined (the normal case — at
          // least one of `connection` / `cloudConnection` exists for any
          // valid model id), pass the native base URL explicitly via
          // `nativeBaseUrl` so the request lands on `/api/chat`. When
          // `endpointConnection` is undefined (a stale connection id
          // pointing at a deleted connection), fall back to the legacy
          // `clientBaseUrl` and let `OllamaClient.nativeChatUrl` strip
          // `/v1` and append `/api/chat` itself.
          const nativeClient = new OllamaClient(
            endpointConnection ? nativeBaseUrl(endpointConnection) : clientBaseUrl,
            apiKey ?? '',
            endpointConnection,
            'native',
          );
          const nativeMessages = convertMessagesToNative(messages);
          const nativeTools = convertToolsToNative(options.tools);
          const nativeConfig = resolveModelRequestConfiguration(model, modelOptions, 'native');
          await this.runStream(
            (callbacks) =>
              nativeClient.streamChat(
                {
                  model: model.apiModel ?? model.id,
                  messages: nativeMessages,
                  ...(nativeTools !== undefined ? { tools: nativeTools } : {}),
                  tool_choice: resolveToolChoice(options.toolMode, options.tools),
                  extraBody: nativeConfig.openaiBody,
                },
                callbacks,
                token,
              ),
            progress,
            model,
            requestChars,
            () => markNativeChatAvailable(connectionId),
          );
          return; // success — no fallback needed
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            markNativeChatUnavailable(connectionId);
            if (isPreferredEndpointExplicit) {
              logger.info(
                `Explicit /api/chat (native) 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
              );
              throw endpointExplicitUnavailableError('native', connectionId);
            }
            logger.info(
              `Auto-mode fallback: /api/chat returned 404 for connection "${connectionId}" — retrying on /chat/completions`,
            );
            // fall through to the /chat/completions path below
          } else {
            throw error; // non-404 — surface, no fallback (no double billing)
          }
        }
      }

      if (primaryEndpoint === 'responses' && !isResponsesKnownUnavailable(connectionId)) {
        try {
          const responsesClient = new ResponsesClient(
            clientBaseUrl,
            apiKey ?? '',
            connection,
          );
          // ADR 0007 — `/v1/responses` consumes the FILTERED payload.
          // When the filter ran (`filterReport !== undefined`), shape
          // the filtered `OpenAICompatibleMessage[]` directly into
          // `/v1/responses` input via `convertOpenAIMessagesToResponsesInput`
          // (no VS Code ↔ OpenAI round-trip — keeps the filter
          // endpoint-agnostic and avoids lossy re-conversion). When the
          // filter did NOT run (`off` fast path), use the original
          // `convertToResponsesInput` on the VS Code `messages` (the
          // 375-test regression path is untouched).
          const { input, instructions } =
            filterReport !== undefined
              ? convertOpenAIMessagesToResponsesInput(filteredMessages)
              : convertToResponsesInput(messages);
          const responsesTools = resolveResponsesTools(filterReport, filteredTools, options.tools);
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
            // Issue #40 — explicit choice: do NOT silently fall back.
            // Surface an actionable error so the user knows their
            // explicit endpoint is unsupported by this connection.
            if (isPreferredEndpointExplicit) {
              logger.info(
                `Explicit /v1/responses 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
              );
              throw endpointExplicitUnavailableError('responses', connectionId);
            }
            logger.info(
              `Auto-mode fallback: /v1/responses returned 404 for connection "${connectionId}" — retrying on /chat/completions`,
            );
            // fall through to /chat/completions below
          } else {
            throw error; // non-404 — surface, no fallback (no double billing)
          }
        }
      }

      // /chat/completions path — primary when global/per-connection
      // setting is 'chat', fallback when 'responses' returned 404, or
      // always for local Ollama.
      if (!isLocal && primaryEndpoint === 'chat' && !isChatKnownUnavailable(connectionId)) {
        try {
          await this.runStream(
            (callbacks) =>
              client.streamChat(
                {
                  model: model.apiModel,
                  // ADR 0007 — `/chat/completions` consumes the
                  // FILTERED payload (`filteredMessages` +
                  // `filteredTools`). At `off` these are the unfiltered
                  // originals, so the 375-test regression path is
                  // untouched.
                  messages: filteredMessages,
                  tools: filteredTools,
                  tool_choice: resolveToolChoice(options.toolMode, options.tools),
                  extraBody: requestConfiguration.openaiBody,
                },
                callbacks,
                token,
              ),
            progress,
            model,
            requestChars,
            () => markChatAvailable(connectionId),
          );
          return; // success — no fallback needed
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            markChatUnavailable(connectionId);
            // Issue #40 — explicit choice: do NOT silently fall back.
            if (isPreferredEndpointExplicit) {
              logger.info(
                `Explicit /chat/completions 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
              );
              throw endpointExplicitUnavailableError('chat', connectionId);
            }
            logger.info(
              `Auto-mode fallback: /chat/completions returned 404 for connection "${connectionId}" — retrying on /v1/responses`,
            );
            // fall through to /v1/responses below
          } else {
            throw error; // non-404 — surface, no fallback
          }
        }
      }

      // If we reach here, either:
      //   - primary was 'responses' and 404'd → /chat/completions fallback
      //   - primary was 'chat' and 404'd → /v1/responses fallback
      //   - local connection → /chat/completions (the only path)
      // For local connections, this is the only path and there is no
      // fallback. For cloud/remote, this is the fallback from the
      // primary endpoint's 404.
      if (!isLocal && primaryEndpoint === 'chat' && isChatKnownUnavailable(connectionId)) {
        // /chat/completions 404'd earlier → try /v1/responses as fallback
        try {
          const responsesClient = new ResponsesClient(
            clientBaseUrl,
            apiKey ?? '',
            connection,
          );
          // ADR 0007 — same filtered-payload routing as the primary
          // /v1/responses path above.
          const { input, instructions } =
            filterReport !== undefined
              ? convertOpenAIMessagesToResponsesInput(filteredMessages)
              : convertToResponsesInput(messages);
          const responsesTools = resolveResponsesTools(filterReport, filteredTools, options.tools);
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
          return;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            markResponsesUnavailable(connectionId);
            logger.info(
              `/v1/responses also returned 404 for connection "${connectionId}" — both endpoints unavailable`,
            );
          }
          throw error;
        }
      }

      // /chat/completions — the final fallback (from responses 404) or
      // the only path for local Ollama.
      await this.runStream(
        (callbacks) =>
          client.streamChat(
            {
              model: model.apiModel,
              // ADR 0007 — `/chat/completions` consumes the FILTERED
              // payload (`filteredMessages` + `filteredTools`). At `off`
              // these are the unfiltered originals.
              messages: filteredMessages,
              tools: filteredTools,
              tool_choice: resolveToolChoice(options.toolMode, options.tools),
              extraBody: requestConfiguration.openaiBody,
            },
            callbacks,
            token,
          ),
        progress,
        model,
        requestChars,
        isLocal ? undefined : () => markChatAvailable(connectionId),
      );
    } catch (error) {
      logger.error('provideLanguageModelChatResponse failed.', error);
      throw classifyStreamError(error);
    }
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
    // Issue #41 — Strand 1: stream lifecycle logging. Record the
    // request start time so stream-start (first chunk) and stream-done
    // can report elapsed ms. The endpoint label is derived from the
    // model's connection at the call site would require plumbing; the
    // model id + apiModel is enough signal for diagnostics.
    const startedAt = Date.now();
    let firstChunkAt: number | undefined;
    let chunkCount = 0;
    const modelLabel = model.apiModel ?? model.id;
    await new Promise<void>((resolve, reject) => {
      void invoke({
        onText: (text: string) => {
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            // Issue #41 — Strand 1: log stream start (first chunk) with
            // time-to-first-token. One line per stream — not per chunk.
            logger.info(
              `Stream start: model="${modelLabel}" ttft=${firstChunkAt - startedAt}ms`,
            );
          }
          chunkCount += 1;
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onThinking: (text: string) => {
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            logger.info(
              `Stream start (thinking): model="${modelLabel}" ttft=${firstChunkAt - startedAt}ms`,
            );
          }
          // Issue #41 review fix (Finding 2): increment `chunkCount`
          // here too, so a thinking-only stream does not log
          // `chunks=0` (which misreads as "stream empty").
          chunkCount += 1;
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
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            logger.info(
              `Stream start (tool_call): model="${modelLabel}" ttft=${firstChunkAt - startedAt}ms`,
            );
          }
          // Issue #41 review fix (Finding 2): increment `chunkCount`
          // here too, so a tool-call-only stream does not log
          // `chunks=0` (which misreads as "stream empty").
          chunkCount += 1;
          progress.report(
            new vscode.LanguageModelToolCallPart(
              toolCall.id,
              toolCall.name,
              toolCall.input,
            ),
          );
        },
        onUsage: (usage: UsageInfo) => {
          // Issue #41 review fix (Finding 3): capture `charsPerToken`
          // BEFORE updating the EMA. The audit compares "what we sent"
          // against "what the server counted" using the estimator's
          // state AT REQUEST TIME. Updating first then logging the
          // already-shifted EMA is self-referential bias that dampens
          // the delta for the first few requests of a session.
          const preUpdateCharsPerToken = this.charsPerToken;
          this.updateTokenEstimate(requestChars, usage);
          // Issue #41 — Strand 3.2: log estimated tokens alongside
          // server-reported usage so the audit can compare "what we
          // sent" vs "what the server counted". Log the delta when it
          // exceeds 20% — that is the signal of redundant content or
          // a conversion bug.
          logger.info(
            formatUsageLog(model.id, usage, requestChars, preUpdateCharsPerToken),
          );
        },
        onDone: () => {
          // Issue #41 — Strand 1: log stream done with total duration
          // + chunk count. Diagnostics for slow streams and to confirm
          // a request actually completed (vs silently dropped).
          const durationMs = Date.now() - startedAt;
          logger.info(
            `Stream done: model="${modelLabel}" duration=${durationMs}ms chunks=${chunkCount}`,
          );
          onSuccess?.();
          resolve();
        },
        onError: (error: Error) => {
          // Issue #41 — Strand 1: log stream error with the error
          // class + status (if HttpError) + duration. One line per
          // failed stream — not per retry (retries log in retry.ts).
          const durationMs = Date.now() - startedAt;
          const status =
            error instanceof HttpError ? ` status=${error.status}` : '';
          logger.error(
            `Stream error: model="${modelLabel}" duration=${durationMs}ms${status} class=${error.constructor.name}`,
            error,
          );
          reject(error);
        },
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
  connection: ConnectionConfig | undefined,
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

  // Issue #41 — Strand 2: surface the effective endpoint in the
  // tooltip. Appended as a new line so the existing `PROVIDER_TOOLTIP`
  // header and the auth-required hint stay where existing readers
  // expect them; the endpoint line is pure diagnostic, no host/auth.
  const endpointLabel = resolveEndpointLabel(connection);
  const baseTooltip = hasApiKey
    ? PROVIDER_TOOLTIP
    : `${PROVIDER_TOOLTIP}\n${AUTH_REQUIRED_DETAIL}`;
  const tooltip = `${baseTooltip}\nEndpoint: ${endpointLabel}`;

  return {
    id: model.id,
    name,
    family: model.family,
    version: model.version,
    detail: model.origin === 'Cloud' ? PROVIDER_TOOLTIP : model.origin,
    tooltip,
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

// Issue #41 — Strand 3.2: exported so the unit test in
// `test/unit/formatUsageLog.test.ts` can assert the estimatedTokens /
// delta audit fields without going through the full provider stream.
export function formatUsageLog(
  modelId: string,
  usage: UsageInfo,
  requestChars?: number,
  charsPerToken?: number,
): string {
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

  // Issue #41 — Strand 3.2: token audit. When the caller passes the
  // request's character count and the current chars-per-token estimate,
  // compute the locally-estimated input token count and compare it
  // against the server-reported `inputTokens`. A delta >20% in either
  // direction is the signal of redundant content (system prompt sent
  // twice, instructions duplicated in `instructions` + a message, tool
  // definitions sent in both `tools` and inline) or a conversion bug.
  // The audit line stays single-line — `logger.info` is one call.
  if (
    requestChars !== undefined &&
    charsPerToken !== undefined &&
    charsPerToken > 0
  ) {
    const estimatedTokens = Math.max(1, Math.ceil(requestChars / charsPerToken));
    parts.push(`estimatedTokens=${estimatedTokens}`);

    if (usage.inputTokens !== undefined && usage.inputTokens > 0) {
      const diff = estimatedTokens - usage.inputTokens;
      const ratio = Math.abs(diff) / usage.inputTokens;
      if (ratio > 0.2) {
        // Sign the delta: `+` when the estimate OVER-counts (likely
        // redundant content sent), `-` when the server counted more
        // than we estimated (likely under-counting in the convert
        // path, e.g. a part dropped before reaching the server).
        const sign = diff > 0 ? '+' : '-';
        const pct = Math.round(ratio * 100);
        parts.push(
          `delta=${sign}${pct}% (audit: check convert path for redundancy)`,
        );
      }
    }
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
