import * as vscode from 'vscode';
import { logger } from './logger.js';
import { OllamaCloudChatProvider } from './provider.js';
import { pickVisionFallbackModel, pickVisionFallbackConnection } from './visionFallbackCommands.js';

/**
 * Issue 17 — smart "Set API Key" notification.
 *
 * When the provider's model information changes (fires on activation,
 * on config changes, and on secret changes) AND no API key is set,
 * prompt the user once per session to set the key. A session-scoped
 * boolean prevents repeat notifications; the flag is cleared (so the
 * prompt can fire again) when the key is set or cleared.
 *
 * Exported (not just file-local) so the race test in
 * `test/race/apiKeyPrompt.test.ts` can drive two concurrent events
 * through the same flag and assert only one prompt is shown. The
 * factory returns the wired disposables plus a `promptCount` getter
 * for the test to inspect — production code ignores those extras.
 */
export interface SmartPromptHandle {
  /** Disposables to push into context.subscriptions. */
  readonly disposables: Array<{ dispose(): unknown }>;
  /** Number of times the prompt was actually shown. Test-only introspection. */
  readonly promptCount: () => number;
  /** Resets the session flag so the prompt can fire again. Test-only. */
  readonly reset: () => void;
}

export function registerApiKeyPrompt(
  context: vscode.ExtensionContext,
  provider: OllamaCloudChatProvider,
): SmartPromptHandle {
  let promptedThisSession = false;
  let promptCount = 0;

  const maybePrompt = (): void => {
    if (promptedThisSession) {
      return;
    }
    // Claim the prompt slot synchronously BEFORE the async IIFE. Two
    // events fired in rapid succession both pass the outer check, but
    // the first to reach here sets the flag so the second's outer check
    // on the next call (or the inner re-check) collapses it. Without
    // setting the flag here, both IIFIs would run concurrently and each
    // would pass the inner re-check — producing two prompts from one
    // logical "no key" state.
    promptedThisSession = true;
    // Do not block the event handler — it must return immediately.
    // `hasApiKey` is async, so we kick off a fire-and-forget IIFE.
    void (async () => {
      const hasApiKey = await provider.auth.hasApiKey();
      if (hasApiKey) {
        // A key exists — release the slot so a future event can prompt
        // if the key is later cleared.
        promptedThisSession = false;
        return;
      }
      promptCount += 1;
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

  return {
    disposables: [resetListener, infoListener],
    promptCount: () => promptCount,
    reset: () => {
      promptedThisSession = false;
    },
  };
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
      vscode.commands.registerCommand('ollamaCloud.setVisionFallbackModel', () =>
        pickVisionFallbackModel(provider),
      ),
      vscode.commands.registerCommand('ollamaCloud.setVisionFallbackConnection', () =>
        pickVisionFallbackConnection(),
      ),
      vscode.lm.registerLanguageModelChatProvider('ollama-cloud', provider),
    );

    // Issue 17 — wire the smart API-key prompt.
    // MEDIUM-1 — push the handle's disposables (resetListener +
    // infoListener) to context.subscriptions so they are disposed on
    // extension deactivation. Discarding the handle left two
    // EventEmitters leaking across dev reloads.
    const promptHandle = registerApiKeyPrompt(context, provider);
    context.subscriptions.push(...promptHandle.disposables);

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
