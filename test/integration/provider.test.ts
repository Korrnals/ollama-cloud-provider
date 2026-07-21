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

/**
 * Vision gate — `provider.ts` throws a clear error when a request
 * carries image parts AND the selected model does NOT support images.
 * It forwards the image as a `data:` URL when the model DOES support
 * images. These tests pin both paths.
 */
describe('OllamaCloudChatProvider.provideLanguageModelChatResponse — vision gate', () => {
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
    });
    originalFetch = global.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function imageMsg(): vscode.LanguageModelChatRequestMessage {
    return {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart('what is this?'),
        new vscode.LanguageModelDataPart(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          'image/png',
        ),
      ] as unknown as vscode.LanguageModelChatRequestMessage['content'],
      name: undefined,
    };
  }

  it('throws when a text-only model receives an image (no silent drop)', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    // gpt-oss:120b is a text-only model (no vision marker, no
    // imageInput metadata). fetch must NOT be called.
    global.fetch = (() => {
      throw new Error('fetch must not be called for a rejected image request');
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [imageMsg()],
          {
            modelOptions: {},
            justification: 'test',
          } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      /does not support image input/,
    );
  });

  it('routes to vision fallback when enabled and primary cannot handle image', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    // Enable the pass-through fallback (ADR 0004). The configured
    // vision model is gemma3:12b — vision-capable, lives on the cloud
    // connection. The primary (gpt-oss:120b) cannot handle images, so
    // the provider must route the turn to gemma3:12b instead of
    // throwing.
    setConfig({
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/gemma3:12b',
    });

    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"vision answer"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      [imageMsg()],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // The fallback fired: fetch was called exactly once, targeting
    // the vision model (gemma3:12b), not the primary. The user sees
    // the vision model's streamed text, not the throw.
    assert.equal(fetchCalls.length, 1, 'fallback issued a single vision call');
    const body = fetchCalls[0].body as { model: string };
    assert.equal(body.model, 'gemma3:12b', 'request targeted the vision model');
    assert.equal(progress.parts.length, 1, 'one text delta reported');
    assert.equal(
      (progress.parts[0] as vscode.LanguageModelTextPart).value,
      'vision answer',
    );
  });

  it('forwards the image as a data URL when the model supports vision', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    // gemma3:12b is a vision-capable model (gemma3 family marker +
    // imageInput metadata). The image must be forwarded in the
    // OpenAI request body as an image_url data URL.
    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"it is a png"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gemma3:12b'),
      [imageMsg()],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // fetch was called exactly once with the chat completions URL.
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith('/chat/completions'));
    // The request body's first user message contains an image_url
    // part with the base64 data URL.
    const body = fetchCalls[0].body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMsg = body.messages.find((m) => m.role === 'user');
    assert.ok(userMsg, 'a user message was sent');
    assert.ok(Array.isArray(userMsg.content), 'content is a multipart array');
    const parts = userMsg.content as Array<{
      type: string;
      image_url?: { url: string };
      text?: string;
    }>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    assert.ok(imagePart, 'an image_url part was forwarded');
    assert.equal(
      imagePart!.image_url!.url,
      'data:image/png;base64,iVBORw==',
    );
  });

  it('allows a text-only model when the request has no images', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"hi back"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    // gpt-oss:120b is text-only, but the request is text-only too —
    // the vision gate must not fire.
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

    assert.equal(fetchCalls.length, 1);
    const body = fetchCalls[0].body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userEntry = body.messages.find((m) => m.role === 'user');
    assert.ok(userEntry);
    // Text-only request → content stays a plain string, not an array.
    assert.equal(userEntry.content, 'hi');
  });
});