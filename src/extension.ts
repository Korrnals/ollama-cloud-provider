import * as vscode from 'vscode';
import { logger } from './logger.js';
import { OllamaCloudChatProvider } from './provider.js';

/**
 * Issue 17 — smart "Set API Key" notification.
 *
 * When the provider's model information changes (fires on activation,
 * on config changes, and on secret changes) AND no API key is set,
 * prompt the user once per session to set the key. A session-scoped
 * boolean prevents repeat notifications; the flag is cleared (so the
 * prompt can fire again) when the key is set or cleared.
 */
function registerApiKeyPrompt(
  context: vscode.ExtensionContext,
  provider: OllamaCloudChatProvider,
): void {
  let promptedThisSession = false;

  const maybePrompt = (): void => {
    if (promptedThisSession) {
      return;
    }
    // Do not block the event handler — it must return immediately.
    // `hasApiKey` is async, so we kick off a fire-and-forget IIFE.
    void (async () => {
      if (promptedThisSession) {
        return;
      }
      const hasApiKey = await provider.auth.hasApiKey();
      if (hasApiKey) {
        return;
      }
      promptedThisSession = true;
      logger.info(
        'Showing API key prompt (no key set, model selected)',
      );
      const choice = await vscode.window.showInformationMessage(
        'Ollama Cloud API key required. Set it now?',
        'Set API Key',
      );
      if (choice === 'Set API Key') {
        await provider.configureApiKey();
      }
    })();
  };

  // Reset the prompt flag when the key changes so a later clear can
  // re-prompt. This mirrors the provider's own secret-change listener.
  const resetListener = context.secrets.onDidChange((event) => {
    if (event.key === 'ollamaCloud.apiKey') {
      promptedThisSession = false;
    }
  });

  const infoListener = provider.onDidChangeLanguageModelChatInformation(
    maybePrompt,
  );

  context.subscriptions.push(resetListener, infoListener);
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info('Activating Ollama Cloud extension.');

  try {
    const provider = new OllamaCloudChatProvider(context);

    context.subscriptions.push(
      vscode.commands.registerCommand('ollamaCloud.setApiKey', () =>
        provider.configureApiKey(),
      ),
      vscode.commands.registerCommand('ollamaCloud.clearApiKey', () =>
        provider.clearApiKey(),
      ),
      vscode.commands.registerCommand('ollamaCloud.showRegisteredModels', () =>
        provider.showRegisteredModels(),
      ),
      vscode.commands.registerCommand('ollamaCloud.showLogs', () =>
        logger.show(),
      ),
      vscode.commands.registerCommand('ollamaCloud.checkConnection', () =>
        provider.checkConnection(),
      ),
      vscode.commands.registerCommand('ollamaCloud.validateConfig', () =>
        provider.validateConfig(),
      ),
      vscode.lm.registerLanguageModelChatProvider('ollama-cloud', provider),
    );

    // Issue 17 — wire the smart API-key prompt.
    registerApiKeyPrompt(context, provider);

    logger.info('Ollama Cloud extension activated.');
  } catch (error) {
    logger.error('Failed to activate Ollama Cloud extension.', error);
    void vscode.window.showErrorMessage(
      'Ollama Cloud failed to activate. Run "Ollama Cloud: Show Logs" for details.',
    );
    throw error;
  }
}

export function deactivate(): void {
  try {
    logger.info('Ollama Cloud extension deactivated.');
  } catch {}
  logger.dispose();
}
