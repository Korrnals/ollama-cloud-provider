import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import {
  countOpenAIRequestChars,
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  getMessageText,
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
import { ModelCatalog, type ModelDefinition } from './modelCatalog.js';
import { OllamaClient } from './ollamaClient.js';
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
          event.affectsConfiguration('ollamaCloud.baseUrl')
        ) {
          if (event.affectsConfiguration('ollamaCloud.baseUrl')) {
            void this.syncModelCatalog();
          }
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
      context.secrets.onDidChange((event) => {
        if (event.key === 'ollamaCloud.apiKey') {
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
      const result = await this.modelCatalog.refresh();
      logger.info(
        `Synced Ollama Cloud model list. changed=${result.changed} count=${result.count}`,
      );
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
    } catch (error) {
      logger.error('Failed to sync Ollama Cloud model list.', error);
    }
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
    const apiKey = await this.authManager.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Ollama Cloud API key not configured. Run "Ollama Cloud: Set API Key".',
      );
    }

    const model = this.modelCatalog.get(modelInfo.id);
    if (!model) {
      throw new Error(`Unknown Ollama Cloud model: ${modelInfo.id}`);
    }

    const client = new OllamaClient(this.authManager.getBaseUrl(), apiKey);
    const modelOptions = options as ModelConfigurationOptions;
    const requestConfiguration = resolveModelRequestConfiguration(
      model,
      modelOptions,
    );
    const openaiMessages = convertMessagesToOpenAI(messages);
    const requestChars = countOpenAIRequestChars(openaiMessages);

    await new Promise<void>((resolve, reject) => {
      void client.streamChat(
        {
          model: model.apiModel,
          messages: openaiMessages,
          tools: convertToolsToOpenAI(options.tools),
          tool_choice: resolveToolChoice(options.toolMode, options.tools),
          extraBody: requestConfiguration.openaiBody,
        },
        {
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
          onDone: () => resolve(),
          onError: (error: Error) => reject(error),
        },
        token,
      );
    });
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
}

function toChatInformation(
  model: ModelDefinition,
  hasApiKey: boolean,
): vscode.LanguageModelChatInformation {
  const configurationSchema = getModelConfigurationSchema(model);

  return {
    id: model.id,
    name: model.name,
    family: model.family,
    version: model.version,
    detail: PROVIDER_TOOLTIP,
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
): vscode.LanguageModelResponsePart | undefined {
  const vscodeWithThinking = vscode as typeof vscode & {
    LanguageModelThinkingPart?: new (
      value: string,
    ) => vscode.LanguageModelResponsePart;
  };

  if (typeof vscodeWithThinking.LanguageModelThinkingPart !== 'function') {
    return undefined;
  }

  return new vscodeWithThinking.LanguageModelThinkingPart(text);
}
