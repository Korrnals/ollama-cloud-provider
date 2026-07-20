import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension.js';

const BASE_URL = 'https://ollama.com/v1';

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Builds a minimal mock ExtensionContext. `vscode.createExtensionContext`
 * is NOT a real VS Code API and is absent from @types/vscode, so the
 * context is built manually with only the surface extension.ts touches.
 */
function makeMockContext(): {
  ctx: vscode.ExtensionContext;
  subscriptions: { dispose(): unknown }[];
} {
  const subscriptions: { dispose(): unknown }[] = [];
  const secrets = new Map<string, string>();
  const secretListeners = new Set<(e: { key: string }) => void>();
  const ctx = {
    subscriptions,
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        for (const listener of secretListeners) {
          listener({ key });
        }
        return Promise.resolve();
      },
      onDidChange: (listener: (e: { key: string }) => void) => {
        secretListeners.add(listener);
        return { dispose: () => secretListeners.delete(listener) };
      },
    },
    extensionPath: '/test/extension-path',
    extensionUri: {
      toString: () => 'file:///test/extension-path',
      fsPath: '/test/extension-path',
    },
  } as unknown as vscode.ExtensionContext;
  return { ctx, subscriptions };
}

describe('extension.activate — smoke test', () => {
  beforeEach(() => {
    setConfig({
      apiKey: '',
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
    });
    delete process.env.OLLAMA_API_KEY;
  });

  it('activates without throwing and registers subscriptions', () => {
    const { ctx, subscriptions } = makeMockContext();
    assert.doesNotThrow(() => activate(ctx), 'activate must not throw');
    // activate pushes the provider, commands, and listeners into
    // context.subscriptions. A healthy activation registers at least
    // the 6 commands + the provider registration + the prompt wiring.
    assert.ok(
      subscriptions.length >= 6,
      `expected at least 6 subscriptions, got ${subscriptions.length}`,
    );
  });

  it('deactivate does not throw', () => {
    assert.doesNotThrow(() => deactivate());
  });

  it('registers the expected command ids via vscode.commands.registerCommand', () => {
    const { ctx } = makeMockContext();
    const registered: string[] = [];
    const originalRegister = vscode.commands.registerCommand;
    vscode.commands.registerCommand = ((id: string) => {
      registered.push(id);
      return { dispose: () => undefined };
    }) as typeof vscode.commands.registerCommand;
    try {
      activate(ctx);
    } finally {
      vscode.commands.registerCommand = originalRegister;
    }
    const expectedCommands = [
      'ollamaCloud.setApiKey',
      'ollamaCloud.clearApiKey',
      'ollamaCloud.showRegisteredModels',
      'ollamaCloud.showLogs',
      'ollamaCloud.checkConnection',
      'ollamaCloud.validateConfig',
    ];
    for (const id of expectedCommands) {
      assert.ok(
        registered.includes(id),
        `command ${id} must be registered, got ${JSON.stringify(registered)}`,
      );
    }
  });
});