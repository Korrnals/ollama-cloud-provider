import * as vscode from 'vscode';
import { logger } from './logger.js';
import { OllamaCloudChatProvider } from './provider.js';

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
