import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { AuthManager } from '../../src/auth.js';
import { performHealthCheck } from '../../src/healthCheck.js';

const API_KEY_SECRET = 'ollamaCloud.apiKey';
const BASE_URL = 'https://ollama.com/v1';

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Builds a minimal mock ExtensionContext with a SecretStorage the
 * test can pre-seed. `vscode.createExtensionContext` does NOT exist
 * in the types package, so we build the context manually.
 */
function makeMockContext(initialSecrets: Record<string, string> = {}): {
  ctx: vscode.ExtensionContext;
  secrets: Map<string, string>;
} {
  const secrets = new Map<string, string>(Object.entries(initialSecrets));
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
        return Promise.resolve();
      },
      onDidChange: () => ({ dispose: () => undefined }),
    },
    extensionPath: '/test/extension-path',
    extensionUri: {
      toString: () => 'file:///test/extension-path',
      fsPath: '/test/extension-path',
    },
  } as unknown as vscode.ExtensionContext;
  return { ctx, secrets };
}

function encodeModelsResponse(models: string[]): string {
  return JSON.stringify({ data: models.map((id) => ({ id })) });
}

describe('healthCheck.performHealthCheck — gates', () => {
  beforeEach(() => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
    });
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    const stub = global.fetch as any;
    if (stub.__isStub) global.fetch = stub.__original ?? global.fetch;
  });

  it('fails at the whitelist gate when baseUrl is not whitelisted', async () => {
    setConfig({
      baseUrl: 'https://evil.example.com/v1',
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
    });
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: 'sk-test-key' });
    const auth = new AuthManager(ctx);
    const result = await performHealthCheck(auth);
    assert.equal(result.ok, false);
    assert.equal(result.message, 'baseUrl not whitelisted');
  });

  it('fails at the API-key gate when no key is set (whitelisted baseUrl)', async () => {
    const { ctx } = makeMockContext();
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
    });
    const auth = new AuthManager(ctx);
    const result = await performHealthCheck(auth);
    assert.equal(result.ok, false);
    assert.equal(result.message, 'API key not set');
  });

  it('passes when whitelist + key + reachability all succeed', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: 'sk-test-key' });
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(encodeModelsResponse(['llama3', 'qwen3']), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    
    ((global.fetch as unknown) as { __isStub?: boolean }).__isStub = true;
    
    ((global.fetch as unknown) as { __original?: typeof fetch }).__original = originalFetch;

    const auth = new AuthManager(ctx);
    const result = await performHealthCheck(auth);
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
    assert.equal(result.message, 'Connection OK');
    assert.equal(result.details?.modelsFound, 2);
    assert.equal(result.details?.baseUrl, BASE_URL);
    assert.ok(typeof result.details?.latencyMs === 'number');

    
    global.fetch = originalFetch;
  });

  it('fails when the reachability fetch returns a non-ok HTTP status', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: 'sk-test-key' });
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response('{"error":{"message":"unauthorized"}}', {
        status: 401,
      })) as typeof fetch;
    
    ((global.fetch as unknown) as { __isStub?: boolean }).__isStub = true;
    
    ((global.fetch as unknown) as { __original?: typeof fetch }).__original = originalFetch;

    const auth = new AuthManager(ctx);
    const result = await performHealthCheck(auth);
    assert.equal(result.ok, false);
    assert.equal(result.message, 'HTTP 401');

    
    global.fetch = originalFetch;
  });

  it('fails when the reachability fetch throws (network error)', async () => {
    const { ctx } = makeMockContext({ [API_KEY_SECRET]: 'sk-test-key' });
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      throw new TypeError('fetch failed: ENOTFOUND');
    }) as typeof fetch;
    
    ((global.fetch as unknown) as { __isStub?: boolean }).__isStub = true;
    
    ((global.fetch as unknown) as { __original?: typeof fetch }).__original = originalFetch;

    const auth = new AuthManager(ctx);
    const result = await performHealthCheck(auth);
    assert.equal(result.ok, false);
    assert.ok(
      result.message.includes('fetch failed') || result.message.includes('ENOTFOUND'),
      `expected a network-error message, got ${result.message}`,
    );

    
    global.fetch = originalFetch;
  });
});