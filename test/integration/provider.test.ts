import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';

const BASE_URL = 'https://ollama.com/v1';

/**
 * Builds a ReadableStream from an array of UTF-8 chunks.
 */
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

function mockResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status });
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Builds a minimal mock ExtensionContext with a pre-seedable
 * SecretStorage. `vscode.createExtensionContext` is not in the
 * types package, so we build the context manually (mirrors
 * healthCheck.test.ts's makeMockContext).
 */
function makeMockContext(
  initialSecrets: Record<string, string> = {},
): {
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

/**
 * Builds a LanguageModelChatInformation that the provider will look up
 * in its ModelCatalog. The id must match a known model's id.
 */
function chatInfoFor(apiModel: string): vscode.LanguageModelChatInformation {
  return {
    id: `ollama-cloud/${apiModel}`,
    name: apiModel,
    family: 'test',
    version: 'test',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    capabilities: { imageInput: false, toolCalling: true },
  } as unknown as vscode.LanguageModelChatInformation;
}

function userMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart(text)],
    name: undefined,
  };
}

/**
 * Progress recorder — collects every reported LanguageModelResponsePart.
 * The stub's `LanguageModelTextPart` stores `value`, so we read it back.
 */
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

describe('OllamaCloudChatProvider.provideLanguageModelChatResponse — happy path', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('streams text deltas to progress.report and resolves on [DONE]', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    // Stub fetch to return a controlled SSE stream with two content
    // deltas then a [DONE] sentinel.
    const chunks = [
      encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n'),
      encode('data: {"choices":[{"delta":{"content":" world"}}]}\n'),
      encode('data: [DONE]\n'),
    ];
    global.fetch = (async () =>
      mockResponse(streamFromChunks(chunks))) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      [userMsg('hi')],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // Two text deltas → two TextParts reported, concatenated text
    // equals "hello world".
    assert.equal(progress.parts.length, 2, 'two text deltas reported');
    const textParts = progress.parts.filter(
      (p) => p instanceof vscode.LanguageModelTextPart,
    );
    assert.equal(textParts.length, 2, 'both parts are LanguageModelTextPart');
    assert.equal(
      (textParts[0] as vscode.LanguageModelTextPart).value,
      'hello',
    );
    assert.equal(
      (textParts[1] as vscode.LanguageModelTextPart).value,
      ' world',
    );
  });

  it('throws when API key is not configured', async () => {
    const { ctx } = makeMockContext();
    // No key stored, no config, no env.

    global.fetch = (async () =>
      mockResponse(streamFromChunks([]))) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [userMsg('hi')],
          {
            modelOptions: {},
            justification: 'test',
          } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      /API key not configured/,
    );
  });

  it('throws when model id is unknown', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    global.fetch = (async () =>
      mockResponse(streamFromChunks([]))) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          {
            id: 'ollama-cloud/totally-fake-model',
          } as unknown as vscode.LanguageModelChatInformation,
          [userMsg('hi')],
          {
            modelOptions: {},
            justification: 'test',
          } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      /Unknown Ollama Cloud model/,
    );
  });
});