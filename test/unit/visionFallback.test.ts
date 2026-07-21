import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  resolveVisionModel,
  shouldFallback,
  executePassThrough,
} from '../../src/visionFallback.js';
import type { ModelDefinition } from '../../src/modelCatalog.js';
import type { ConnectionConfig } from '../../src/connections.js';

/**
 * Vision Fallback Pass-through unit tests (ADR 0004).
 *
 * Covers the three pure-ish entry points:
 *   - `shouldFallback` — gate decision (primary non-vision + image).
 *   - `resolveVisionModel` — configured-model path, auto-search path,
 *     null-when-nothing-found path.
 *   - `executePassThrough` — notification fired before streaming,
 *     vision connection's OllamaClient used (not primary's),
 *     CancellationToken propagated, log entry does NOT contain the
 *     image data URL (security test).
 *
 * The provider-level end-to-end behaviour (throw when fallback
 * disabled, vision answers when enabled) is in
 * `test/integration/provider.test.ts`.
 */

const { LanguageModelDataPart, LanguageModelTextPart, LanguageModelChatMessageRole } =
  vscode;

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Builds a minimal ModelDefinition with the given vision capability
 * and connection id.
 */
function makeModel(
  id: string,
  connectionId: string,
  imageInput: boolean,
): ModelDefinition {
  return {
    id,
    apiModel: id.split('/').pop() ?? id,
    name: id,
    family: 'test',
    version: 'test',
    detail: 'test',
    connectionId,
    origin: 'Cloud',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    reasoning: false,
    capabilities: { imageInput, toolCalling: true },
  };
}

function makeConnection(
  id: string,
  type: ConnectionConfig['type'] = 'cloud',
): ConnectionConfig {
  return {
    id,
    label: id,
    type,
    enabled: true,
    baseUrl: `https://${id}.example/v1`,
    openaiCompatiblePath: '',
    allowedBaseUrls: [`https://${id}.example/v1`],
    visionModels: [],
    requiresApiKey: type !== 'local',
  };
}

function textMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(text)],
    name: undefined,
  };
}

function imageMsg(): vscode.LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: [
      new LanguageModelTextPart('what is this?'),
      new LanguageModelDataPart(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        'image/png',
      ),
    ] as unknown as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

describe('visionFallback.shouldFallback', () => {
  it('returns true when primary is non-vision and request has image parts', () => {
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    assert.equal(shouldFallback(primary, [imageMsg()]), true);
  });

  it('returns false when primary is vision-capable (no fallback needed)', () => {
    const primary = makeModel('ollama-cloud/gemma3:12b', 'cloud', true);
    assert.equal(shouldFallback(primary, [imageMsg()]), false);
  });

  it('returns false when there are no image parts', () => {
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    assert.equal(shouldFallback(primary, [textMsg('hello')]), false);
  });
});

describe('visionFallback.resolveVisionModel', () => {
  afterEach(() => {
    setConfig({});
  });

  it('returns the configured model when visionFallback.model is set', () => {
    setConfig({ 'visionFallback.model': 'ollama-cloud/gemma3:12b' });
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('ollama-cloud/gemma3:12b', 'cloud', true);
    const catalog = [primary, vision];
    const target = resolveVisionModel(primary, undefined, catalog, []);
    assert.ok(target, 'expected a vision target');
    assert.equal(target!.model.id, 'ollama-cloud/gemma3:12b');
  });

  it('auto-searches the first vision-capable model when model not set', () => {
    setConfig({});
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('ollama-cloud/gemma3:12b', 'cloud', true);
    const catalog = [primary, vision];
    const target = resolveVisionModel(primary, undefined, catalog, []);
    assert.ok(target, 'expected an auto-searched vision target');
    assert.equal(target!.model.id, 'ollama-cloud/gemma3:12b');
  });

  it('returns null when no vision model is found (neither configured nor in catalog)', () => {
    setConfig({});
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const other = makeModel('ollama-cloud/gpt-oss:20b', 'cloud', false);
    const catalog = [primary, other];
    const target = resolveVisionModel(primary, undefined, catalog, []);
    assert.equal(target, null);
  });

  it('skips the primary model itself during auto-search', () => {
    setConfig({});
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const catalog = [primary];
    const target = resolveVisionModel(primary, undefined, catalog, []);
    assert.equal(target, null);
  });
});

describe('visionFallback.executePassThrough', () => {
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let infoMessages: string[];
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;

  beforeEach(() => {
    setConfig({
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/gemma3:12b',
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      requestTimeoutMs: 120000,
      maxRetries: 0,
    });
    originalFetch = global.fetch;
    fetchCalls = [];
    infoMessages = [];
    originalShowInformationMessage = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (async (
      message: string,
    ): Promise<unknown> => {
      infoMessages.push(message);
      return undefined;
    }) as typeof vscode.window.showInformationMessage;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vscode.window.showInformationMessage = originalShowInformationMessage;
    setConfig({});
  });

  function makeMockContext(initialSecrets: Record<string, string> = {}) {
    const secrets = new Map<string, string>(Object.entries(initialSecrets));
    return {
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
  }

  function makeProgress(): vscode.Progress<vscode.LanguageModelResponsePart> & {
    parts: vscode.LanguageModelResponsePart[];
  } {
    const parts: vscode.LanguageModelResponsePart[] = [];
    return {
      parts,
      report: (part: vscode.LanguageModelResponsePart): void => {
        parts.push(part);
      },
    };
  }

  function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
  }

  function encode(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  it('fires the routing disclosure notification before streaming', async () => {
    const { AuthManager } = await import('../../src/auth.js');
    const ctx = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    const authManager = new AuthManager(ctx);
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('ollama-cloud/gemma3:12b', 'cloud', true);
    const catalog = [primary, vision];
    const connections: ConnectionConfig[] = [];

    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"it is a png"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await executePassThrough({
      primaryModel: primary,
      primaryConnection: undefined,
      messages: [imageMsg()],
      options: {} as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
      authManager,
      catalog,
      connections,
    });

    assert.ok(
      infoMessages.some((m) => m.startsWith('Vision fallback: answered by')),
      `expected a routing disclosure notification, got: ${JSON.stringify(infoMessages)}`,
    );
    assert.ok(
      infoMessages.some((m) => m.includes('could not handle image')),
      'notification must mention the primary could not handle the image',
    );
  });

  it('uses the vision connection OllamaClient (not the primary)', async () => {
    const { AuthManager } = await import('../../src/auth.js');
    const ctx = makeMockContext({
      'ollamaCloud.apiKey': 'sk-primary-key',
      'ollamaCloud.apiKey.vision-conn': 'sk-vision-key',
    });
    const authManager = new AuthManager(ctx);
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel(
      'ollama-cloud/vision-conn/gemma3:12b',
      'vision-conn',
      true,
    );
    const catalog = [primary, vision];
    const connections: ConnectionConfig[] = [
      makeConnection('vision-conn', 'remote'),
    ];

    setConfig({
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/vision-conn/gemma3:12b',
      'visionFallback.connection': 'vision-conn',
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      connections: [
        {
          id: 'vision-conn',
          label: 'Vision',
          type: 'remote',
          enabled: true,
          baseUrl: 'https://vision-conn.example/v1',
          allowedBaseUrls: ['https://vision-conn.example/v1'],
          requiresApiKey: true,
        },
      ],
    });

    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"seen"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await executePassThrough({
      primaryModel: primary,
      primaryConnection: undefined,
      messages: [imageMsg()],
      options: {} as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
      authManager,
      catalog,
      connections,
    });

    assert.equal(fetchCalls.length, 1);
    assert.ok(
      fetchCalls[0]!.url.startsWith('https://vision-conn.example/v1'),
      `expected fetch to the vision connection, got: ${fetchCalls[0]!.url}`,
    );
  });

  it('propagates the CancellationToken to the vision stream', async () => {
    const { AuthManager } = await import('../../src/auth.js');
    const ctx = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    const authManager = new AuthManager(ctx);
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('ollama-cloud/gemma3:12b', 'cloud', true);
    const catalog = [primary, vision];
    const connections: ConnectionConfig[] = [];

    let abortSeen = false;
    global.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) {
        // Faithful to real fetch: an already-aborted signal rejects
        // synchronously. The abort event fired before fetch was called
        // (during streamChat's entry, when it observed the token was
        // already cancelled), so a late-registered listener would miss
        // it — real fetch checks `signal.aborted` directly. The mock
        // must do the same or it masks the production race fix.
        if (signal.aborted) {
          abortSeen = true;
        }
        signal.addEventListener('abort', () => {
          abortSeen = true;
        });
      }
      // Never resolve — the test cancels before the stream completes.
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    const progress = makeProgress();
    const cts = new vscode.CancellationTokenSource();

    void executePassThrough({
      primaryModel: primary,
      primaryConnection: undefined,
      messages: [imageMsg()],
      options: {} as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token: cts.token,
      authManager,
      catalog,
      connections,
    });

    // Cancel immediately — the vision fetch must observe the abort.
    cts.cancel();
    // Allow the microtask queue to flush the abort listener.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(abortSeen, true, 'CancellationToken must reach the vision fetch');
    // Clean up the pending promise to avoid unhandled rejection noise.
    cts.dispose();
  });

  it('log entry does NOT contain the image data URL (security)', async () => {
    const { AuthManager } = await import('../../src/auth.js');
    const { logger } = await import('../../src/logger.js');
    const ctx = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    const authManager = new AuthManager(ctx);
    const primary = makeModel('ollama-cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('ollama-cloud/gemma3:12b', 'cloud', true);
    const catalog = [primary, vision];
    const connections: ConnectionConfig[] = [];

    const logged: string[] = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (message: string, ...details: unknown[]): void => {
      logged.push(`${message} ${details.map((d) => JSON.stringify(d)).join(' ')}`);
    };

    try {
      global.fetch = (async () => {
        return new Response(
          streamFromChunks([
            encode('data: {"choices":[{"delta":{"content":"x"}}]}\n'),
            encode('data: [DONE]\n'),
          ]),
          { status: 200 },
        );
      }) as typeof fetch;

      const progress = makeProgress();
      const token = new vscode.CancellationTokenSource().token;

      await executePassThrough({
        primaryModel: primary,
        primaryConnection: undefined,
        messages: [imageMsg()],
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress,
        token,
        authManager,
        catalog,
        connections,
      });

      const visionLog = logged.find((line) =>
        line.includes('vision fallback fired'),
      );
      assert.ok(visionLog, 'expected a "vision fallback fired" log entry');
      assert.ok(
        !visionLog!.includes('data:image/'),
        'log must NOT contain the image data URL',
      );
      assert.ok(
        !visionLog!.includes('iVBOR'),
        'log must NOT contain raw base64 image bytes',
      );
      assert.ok(
        visionLog!.includes('imageHash'),
        'log must include the image hash for correlation',
      );
    } finally {
      logger.info = originalInfo;
    }
  });
});