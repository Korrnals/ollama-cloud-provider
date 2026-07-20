import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { AuthManager } from '../../src/auth.js';

const API_KEY_SECRET = 'ollamaCloud.apiKey';

/**
 * Builds a minimal mock ExtensionContext. `vscode`'s types-only
 * package does NOT expose `createExtensionContext`, so the runtime
 * stub helper cannot be used under tsc. This builder mirrors only
 * the SecretStorage + subscriptions surface `AuthManager` touches.
 */
function makeMockContext(initialSecrets: Record<string, string> = {}): {
  ctx: vscode.ExtensionContext;
  secrets: Map<string, string>;
  listeners: Set<(e: { key: string }) => void>;
} {
  const secrets = new Map<string, string>(Object.entries(initialSecrets));
  const listeners = new Set<(e: { key: string }) => void>();
  const ctx = {
    subscriptions: [] as { dispose(): unknown }[],
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        for (const listener of listeners) {
          listener({ key });
        }
        return Promise.resolve();
      },
      onDidChange: (listener: (e: { key: string }) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    extensionPath: '/test/extension-path',
    extensionUri: {
      toString: () => 'file:///test/extension-path',
      fsPath: '/test/extension-path',
    },
  } as unknown as vscode.ExtensionContext;
  return { ctx, secrets, listeners };
}

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

describe('auth.AuthManager — fallback chain', () => {
  beforeEach(() => {
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1' });
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    delete process.env.OLLAMA_API_KEY;
  });

  it('prefers SecretStorage over config and env', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: 'sk-secret-key' });
    setConfig({ apiKey: 'sk-config-key', baseUrl: 'https://ollama.com/v1' });
    process.env.OLLAMA_API_KEY = 'sk-env-key';
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), 'sk-secret-key');
  });

  it('falls back to config when SecretStorage is empty', async () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: 'sk-config-key', baseUrl: 'https://ollama.com/v1' });
    process.env.OLLAMA_API_KEY = 'sk-env-key';
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), 'sk-config-key');
  });

  it('falls back to env when SecretStorage and config are empty', async () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1' });
    process.env.OLLAMA_API_KEY = 'sk-env-key';
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), 'sk-env-key');
  });

  it('returns undefined when no key is configured anywhere', async () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1' });
    delete process.env.OLLAMA_API_KEY;
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), undefined);
  });

  it('trims whitespace from stored secret', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: '  sk-padded  ' });
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), 'sk-padded');
  });

  it('trims whitespace from configured key', async () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '  sk-config  ', baseUrl: 'https://ollama.com/v1' });
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), 'sk-config');
  });

  it('treats whitespace-only secret as absent and falls back', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: '   ' });
    setConfig({ apiKey: 'sk-config-key', baseUrl: 'https://ollama.com/v1' });
    const auth = new AuthManager(ctx);
    assert.equal(await auth.getApiKey(), 'sk-config-key');
  });

  it('hasApiKey returns true when a key exists in SecretStorage', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: 'sk-key' });
    const auth = new AuthManager(ctx);
    assert.equal(await auth.hasApiKey(), true);
  });

  it('hasApiKey returns false when no key is set anywhere', async () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1' });
    delete process.env.OLLAMA_API_KEY;
    const auth = new AuthManager(ctx);
    assert.equal(await auth.hasApiKey(), false);
  });

  it('setApiKey stores the value in SecretStorage', async () => {
    const { ctx, secrets } = makeMockContext();
    const auth = new AuthManager(ctx);
    await auth.setApiKey('sk-new-key');
    assert.equal(secrets.get(API_KEY_SECRET), 'sk-new-key');
  });

  it('deleteApiKey removes the value from SecretStorage', async () => {
    const { ctx, secrets } = makeMockContext({ [API_KEY_SECRET]: 'sk-key' });
    const auth = new AuthManager(ctx);
    await auth.deleteApiKey();
    assert.equal(secrets.has(API_KEY_SECRET), false);
  });

  it('deleteApiKey fires onDidChange with the api key', async () => {
    const { ctx, listeners } = makeMockContext({ [API_KEY_SECRET]: 'sk-key' });
    let firedKey: string | undefined;
    listeners.add((e) => {
      firedKey = e.key;
    });
    const auth = new AuthManager(ctx);
    await auth.deleteApiKey();
    assert.equal(firedKey, API_KEY_SECRET);
  });
});

describe('auth.AuthManager — getRootUrl', () => {
  beforeEach(() => {
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1' });
  });

  it('strips the /v1 suffix from a valid URL', () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1' });
    const auth = new AuthManager(ctx);
    assert.equal(auth.getRootUrl(), 'https://ollama.com');
  });

  it('strips a trailing slash on /v1/', () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '', baseUrl: 'https://ollama.com/v1/' });
    const auth = new AuthManager(ctx);
    assert.equal(auth.getRootUrl(), 'https://ollama.com');
  });

  it('falls back to regex strip when the configured URL is invalid', () => {
    const { ctx } = makeMockContext();
    // Invalid URL — URL constructor throws, getRootUrl falls back to
    // the regex path that strips /v1 from the tail.
    setConfig({ apiKey: '', baseUrl: 'not-a-url/v1' });
    const auth = new AuthManager(ctx);
    assert.equal(auth.getRootUrl(), 'not-a-url');
  });

  it('returns the input unchanged when URL is valid and has no /v1', () => {
    const { ctx } = makeMockContext();
    setConfig({ apiKey: '', baseUrl: 'https://example.com/api' });
    const auth = new AuthManager(ctx);
    assert.equal(auth.getRootUrl(), 'https://example.com/api');
  });
});