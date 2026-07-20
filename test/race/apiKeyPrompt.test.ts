import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { registerApiKeyPrompt } from '../../src/extension.js';

/**
 * Issue 17 — smart "Set API Key" notification race.
 *
 * `registerApiKeyPrompt` subscribes to the provider's
 * `onDidChangeLanguageModelChatInformation` event. When model information
 * changes AND no API key is set, it prompts the user once per session.
 *
 * The prompt is async (it awaits `provider.auth.hasApiKey()`), so two
 * events fired in rapid succession race through the async check. The
 * `promptedThisSession` flag + the inner re-check must guarantee exactly
 * one prompt is shown, not two. This is the race the test exercises.
 *
 * The test builds a minimal mock provider + context (no real AuthManager
 * or ModelCatalog needed) and fires the event twice without yielding to
 * the event loop between fires. The async `hasApiKey` resolves on the
 * next microtask, so both events enter the IIFE before either re-check
 * runs. Without the inner guard, `promptCount` would be 2.
 */

interface MockProvider {
  auth: { hasApiKey: () => Promise<boolean> };
  onDidChangeLanguageModelChatInformation: (
    listener: () => void,
  ) => { dispose(): void };
}

function makeMockProvider(hasApiKey: boolean): {
  provider: MockProvider;
  fire: () => void;
} {
  const listeners: Array<() => void> = [];
  const provider: MockProvider = {
    auth: {
      hasApiKey: () => Promise.resolve(hasApiKey),
    },
    onDidChangeLanguageModelChatInformation: (listener) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
  };
  return {
    provider,
    fire: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function makeMockContext(): {
  ctx: vscode.ExtensionContext;
  secretListeners: Set<(e: { key: string }) => void>;
} {
  const secretListeners = new Set<(e: { key: string }) => void>();
  const ctx = {
    subscriptions: [] as { dispose(): unknown }[],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: (listener: (e: { key: string }) => void) => {
        secretListeners.add(listener);
        return { dispose: () => secretListeners.delete(listener) };
      },
    },
    extensionPath: '/test',
    extensionUri: { toString: () => 'file:///test', fsPath: '/test' },
  } as unknown as vscode.ExtensionContext;
  return { ctx, secretListeners };
}

describe('registerApiKeyPrompt — race condition', () => {
  it('fires only one prompt when two events arrive before the async hasApiKey resolves', async () => {
    // Stub showInformationMessage so it resolves immediately and does
    // not block. The prompt count is what we assert, not the message.
    const originalShowInfo = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;

    try {
      const { ctx } = makeMockContext();
      const { provider, fire } = makeMockProvider(false);

      const handle = registerApiKeyPrompt(
        ctx,
        provider as unknown as Parameters<typeof registerApiKeyPrompt>[1],
      );

      // Fire two events synchronously — both enter maybePrompt before the
      // first async hasApiKey resolves. The inner `promptedThisSession`
      // re-check must collapse the second into a no-op.
      fire();
      fire();

      // Let the microtask queue drain so the async IIFIs complete.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      assert.equal(
        handle.promptCount(),
        1,
        'two rapid events must produce exactly one prompt, not two',
      );

      for (const disposable of handle.disposables) {
        disposable.dispose();
      }
    } finally {
      vscode.window.showInformationMessage = originalShowInfo;
    }
  });

  it('does not prompt when an API key is already set', async () => {
    const originalShowInfo = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;

    try {
      const { ctx } = makeMockContext();
      const { provider, fire } = makeMockProvider(true);

      const handle = registerApiKeyPrompt(
        ctx,
        provider as unknown as Parameters<typeof registerApiKeyPrompt>[1],
      );

      fire();

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      assert.equal(
        handle.promptCount(),
        0,
        'must not prompt when an API key is already set',
      );

      for (const disposable of handle.disposables) {
        disposable.dispose();
      }
    } finally {
      vscode.window.showInformationMessage = originalShowInfo;
    }
  });

  it('re-prompts after the API key is cleared (reset flag)', async () => {
    const originalShowInfo = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;

    try {
      const { ctx, secretListeners } = makeMockContext();
      const { provider, fire } = makeMockProvider(false);

      const handle = registerApiKeyPrompt(
        ctx,
        provider as unknown as Parameters<typeof registerApiKeyPrompt>[1],
      );

      // First event — prompts once.
      fire();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(handle.promptCount(), 1, 'first event prompts once');

      // Simulate key clear — the secret-change listener resets the flag.
      for (const listener of secretListeners) {
        listener({ key: 'ollamaCloud.apiKey' });
      }

      // Second event — re-prompts because the flag was reset.
      fire();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(handle.promptCount(), 2, 're-prompts after key clear');

      for (const disposable of handle.disposables) {
        disposable.dispose();
      }
    } finally {
      vscode.window.showInformationMessage = originalShowInfo;
    }
  });
});