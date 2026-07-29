import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearCapabilityCache, markResponsesUnavailable } from '../../src/capabilityCache.js';
import { logger } from '../../src/logger.js';

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
      // ADR 0006 — cloud defaults to /v1/responses. These legacy
      // tests exercise the /chat/completions SSE format (`choices[].delta`
      // + `[DONE]`), so pin the cloud connection to `preferredEndpoint: 'chat'`
      // to keep testing the fallback path.
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
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
    // ADR 0006 — the capability cache is process-global; a prior
    // suite's 404 may have marked the cloud connection's
    // /v1/responses unavailable. Clear it so this suite's
    // preferredEndpoint: 'chat' pin is the only endpoint signal.
    clearCapabilityCache();
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      // ADR 0006 — pin cloud to /chat/completions for the tests that
      // assert the chat-format request body and SSE chunks.
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
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
    // throwing. Pin the cloud connection to /chat/completions so the
    // mock's chat-format SSE stream is consumed correctly (the test
    // asserts the fallback fires, not which endpoint is used).
    clearCapabilityCache();
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
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

/**
 * ADR 0004 constraint 9 — no silent degradation. When the user enables
 * `visionFallback.enabled` but the configured `visionFallback.model`
 * points at a non-existent (or non-vision) id, the provider must throw
 * an actionable error to the user, not silently drop the image or fall
 * back to the text-only primary.
 */
describe('OllamaCloudChatProvider.provideLanguageModelChatResponse — fallback enabled but no vision model', () => {
  let originalFetch: typeof fetch;

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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setConfig({});
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

  it('throws when fallback is enabled but visionFallback.model is a non-existent id', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      'visionFallback.enabled': true,
      // No catalog model has this id → resolveVisionModel falls through
      // to auto-search. Auto-search also fails because the catalog was
      // refreshed to contain ONLY the non-vision primary (see the
      // stubbed /v1/models response below) → executePassThrough throws
      // (ADR 0004 constraint 9 — no silent degradation).
      'visionFallback.model': 'ollama-cloud/totally-fake-vision-model',
    });

    // First fetch: the catalog refresh (/v1/models). Return ONLY the
    // primary model id so the catalog has no vision-capable model to
    // auto-search. Subsequent fetches (the chat stream) must never
    // happen — the provider must throw before reaching them.
    let fetchCount = 0;
    global.fetch = (async (input: string | URL) => {
      fetchCount += 1;
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'gpt-oss:120b' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(
        'chat fetch must not be called when no vision model resolves',
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    // Refresh the catalog so `list()` returns only the primary model.
    // Without this, the default KNOWN_MODELS snapshot includes
    // gemma3:12b (vision-capable, cloud) and auto-search would find it.
    await provider.syncModelCatalog(true);

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
      /No vision-capable model found/,
    );
    // Exactly one fetch — the catalog refresh. The chat fetch must
    // never have been issued.
    assert.equal(fetchCount, 1, 'only the catalog refresh fetch may occur');
  });
});

/**
 * ADR 0006 Phase 3 — structured reasoning wiring. The `/v1/responses`
 * path emits `response.reasoning_summary_text.delta` events;
 * `responsesClient` forwards them to `callbacks.onThinking`;
 * `provider.runStream` maps `onThinking` to
 * `vscode.LanguageModelThinkingPart` (VS Code 1.103+, TextPart fallback
 * for older versions). These tests verify both ends of that chain via
 * the public provider surface.
 */
describe('OllamaCloudChatProvider — structured reasoning (ADR 0006 Phase 3)', () => {
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    clearCapabilityCache();
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      // Cloud defaults to /v1/responses (auto) so the reasoning
      // events flow through the responses client.
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
    });
    originalFetch = global.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setConfig({});
  });

  function sseEvent(type: string, json: string): Uint8Array {
    return encode(`event: ${type}\ndata: ${json}\n\n`);
  }

  it('maps reasoning events to LanguageModelThinkingPart in progress.report', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    const chunks = [
      sseEvent('response.created', '{"response":{"id":"r1","status":"in_progress"}}'),
      sseEvent(
        'response.reasoning_summary_text.delta',
        '{"delta":"reasoning step 1","item_id":"rs1"}',
      ),
      sseEvent(
        'response.reasoning_summary_text.delta',
        '{"delta":" step 2","item_id":"rs1"}',
      ),
      sseEvent('response.output_text.delta', '{"delta":"final answer","item_id":"m1"}'),
      sseEvent(
        'response.completed',
        '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      ),
    ];

    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return mockResponse(streamFromChunks(chunks));
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      [userMsg('explain step by step')],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // The request targeted /v1/responses (not /chat/completions).
    assert.equal(fetchCalls.length, 1, 'one responses fetch');
    assert.ok(
      fetchCalls[0].url.endsWith('/responses'),
      `expected /responses URL, got ${fetchCalls[0].url}`,
    );

    // Two reasoning deltas + one text delta = three parts reported.
    assert.equal(progress.parts.length, 3, 'three parts reported');

    // The stub defines LanguageModelThinkingPart, so the two
    // reasoning deltas must surface as ThinkingPart instances.
    const thinkingParts = progress.parts.filter(
      (part) => part instanceof vscode.LanguageModelThinkingPart,
    );
    assert.equal(thinkingParts.length, 2, 'two thinking parts reported');
    assert.equal(
      (thinkingParts[0] as vscode.LanguageModelThinkingPart).value,
      'reasoning step 1',
    );
    assert.equal(
      (thinkingParts[1] as vscode.LanguageModelThinkingPart).value,
      ' step 2',
    );

    // The text delta surfaces as a TextPart after the thinking parts.
    const textParts = progress.parts.filter(
      (part) => part instanceof vscode.LanguageModelTextPart,
    );
    assert.equal(textParts.length, 1, 'one text part reported');
    assert.equal((textParts[0] as vscode.LanguageModelTextPart).value, 'final answer');
  });

  it('falls back to /chat/completions when /v1/responses returns 404 (no reasoning)', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });

    let callCount = 0;
    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      callCount += 1;
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      // First call — /v1/responses → 404. Second call —
      // /chat/completions → success stream.
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"chat answer"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

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

    // Two fetches: /v1/responses (404) then /chat/completions.
    assert.equal(callCount, 2, 'fallback issued a second chat fetch');
    assert.ok(fetchCalls[0].url.endsWith('/responses'));
    assert.ok(fetchCalls[1].url.endsWith('/chat/completions'));

    // Only the chat text delta surfaces — no thinking parts on the
    // /chat/completions path (it never emits onThinking).
    assert.equal(progress.parts.length, 1, 'one text delta reported');
    assert.equal(
      (progress.parts[0] as vscode.LanguageModelTextPart).value,
      'chat answer',
    );
  });
});

/**
 * ADR 0006 Phase 3 — vision fallback endpoint dispatch. The vision
 * pass-through must mirror `provider.ts`: a cloud vision connection
 * routes the fallback turn to `/v1/responses` (with 404 fallback to
 * `/chat/completions`); a local vision connection routes directly to
 * `/chat/completions`.
 */
describe('OllamaCloudChatProvider — vision fallback endpoint dispatch (ADR 0006 Phase 3)', () => {
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    clearCapabilityCache();
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      // Cloud default endpoint is 'auto' — the vision fallback turn
      // should try /v1/responses first for the cloud vision model.
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
    });
    originalFetch = global.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setConfig({});
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

  function sseEvent(type: string, json: string): Uint8Array {
    return encode(`event: ${type}\ndata: ${json}\n\n`);
  }

  it('routes the vision turn to /v1/responses for a cloud vision connection', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/gemma3:12b',
    });

    const chunks = [
      sseEvent('response.created', '{"response":{"id":"r1","status":"in_progress"}}'),
      sseEvent(
        'response.reasoning_summary_text.delta',
        '{"delta":"analyzing image","item_id":"rs1"}',
      ),
      sseEvent('response.output_text.delta', '{"delta":"it is a png","item_id":"m1"}'),
      sseEvent(
        'response.completed',
        '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
      ),
    ];

    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return mockResponse(streamFromChunks(chunks));
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

    // One fetch — the /v1/responses path (cloud + auto, no prior 404).
    assert.equal(fetchCalls.length, 1, 'single vision fetch to /v1/responses');
    assert.ok(
      fetchCalls[0].url.endsWith('/responses'),
      `expected /responses URL, got ${fetchCalls[0].url}`,
    );

    // The request body uses the /v1/responses input[] shape (not
    // messages[]).
    const body = fetchCalls[0].body as { input: unknown; messages?: unknown };
    assert.ok(Array.isArray(body.input), 'request used input[] shape');
    assert.equal(body.messages, undefined, 'no messages[] on /v1/responses');

    // Reasoning + text both surfaced.
    const thinkingParts = progress.parts.filter(
      (part) => part instanceof vscode.LanguageModelThinkingPart,
    );
    assert.equal(thinkingParts.length, 1, 'one thinking part reported');
    assert.equal(
      (thinkingParts[0] as vscode.LanguageModelThinkingPart).value,
      'analyzing image',
    );
    const textParts = progress.parts.filter(
      (part) => part instanceof vscode.LanguageModelTextPart,
    );
    assert.equal(textParts.length, 1, 'one text part reported');
    assert.equal((textParts[0] as vscode.LanguageModelTextPart).value, 'it is a png');
  });

  it('falls back to /chat/completions when the vision /v1/responses returns 404', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/gemma3:12b',
    });

    let callCount = 0;
    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      callCount += 1;
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"vision chat answer"}}]}\n'),
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

    // Two fetches: /v1/responses (404) then /chat/completions.
    assert.equal(callCount, 2, 'vision fallback issued a second chat fetch');
    assert.ok(fetchCalls[0].url.endsWith('/responses'));
    assert.ok(fetchCalls[1].url.endsWith('/chat/completions'));

    // The chat path surfaces the text delta; no thinking parts.
    assert.equal(progress.parts.length, 1, 'one text delta reported');
    assert.equal(
      (progress.parts[0] as vscode.LanguageModelTextPart).value,
      'vision chat answer',
    );
  });
});

/**
 * Issue #40 — endpoint fallback policy. When the user EXPLICITLY chose
 * the primary endpoint (per-connection `'responses'`/`'chat'`, OR a
 * global `preferredEndpoint` the user actually configured rather than
 * the default), a 404 from that endpoint does NOT silently fall back.
 * The provider throws an actionable `LanguageModelError` with a hint.
 * When the effective choice is `'auto'` (default or inherited from a
 * default global), the prior fallback + log-warning behaviour holds.
 * Local Ollama is unaffected — always `/chat/completions`, no fallback.
 *
 * Coverage:
 *   (a) explicit responses + 404 → error with hint, no fallback
 *   (b) explicit chat + 404 → error, no fallback
 *   (c) auto + 404 → fallback + log
 *   (d) local → unaffected (always /chat/completions)
 */
describe('OllamaCloudChatProvider — endpoint fallback policy (Issue #40)', () => {
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; status: number }>;
  let logged: string[];
  let originalInfo: typeof logger.info;
  const LOCAL_URL = 'http://localhost:11434';

  beforeEach(() => {
    // The capability cache is process-global; a prior suite's 404 may
    // have marked the connection's endpoint unavailable. Clear it so
    // each test's 404 decision is driven by a live round-trip, not a
    // memoized state from another suite.
    clearCapabilityCache();
    fetchCalls = [];
    logged = [];
    originalFetch = global.fetch;
    // Capture logger.info output so the auto-mode fallback log line
    // can be asserted. Mirror the visionFallback.test.ts pattern.
    originalInfo = logger.info.bind(logger);
    logger.info = (message: string, ...details: unknown[]): void => {
      logged.push(`${message} ${details.map((d) => JSON.stringify(d)).join(' ')}`);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.info = originalInfo;
    // Reset config + inspection metadata so no test leaks explicitness
    // state into the next suite (the stub's config + inspection maps
    // are shared globals across tests).
    setConfig({});
    vscode.workspace
      .getConfiguration('ollamaCloud')
      ._setInspection('preferredEndpoint', null);
  });

  /**
   * Fetch stub that returns 404 for `path` and a success SSE stream
   * otherwise. Used to confirm the provider does NOT fall back to the
   * other endpoint in explicit mode.
   */
  function fetch404On(path: '/responses' | '/chat/completions'): typeof fetch {
    return (async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const status = url.endsWith(path) ? 404 : 200;
      fetchCalls.push({ url, status });
      if (status === 404) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;
  }

  it('(a) explicit responses + 404 → throws LanguageModelError with hint, no fallback', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    // Per-connection 'responses' is ALWAYS explicit (task spec point 1).
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'responses' },
      ],
    });
    global.fetch = fetch404On('/responses');

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [userMsg('hi')],
          { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      (err: unknown) => {
        // Surfaced as a LanguageModelError with NotFound code + the
        // actionable hint message naming the endpoint, connection, and
        // the two remediation paths.
        assert.ok(err instanceof vscode.LanguageModelError, 'throws LanguageModelError');
        assert.equal((err as vscode.LanguageModelError).code, 'NotFound');
        const msg = (err as Error).message;
        assert.match(msg, /Endpoint \/v1\/responses returned 404 for connection "cloud"/);
        assert.match(msg, /You have explicitly chosen this endpoint/);
        assert.match(msg, /Set "ollamaCloud.preferredEndpoint" to "auto"/);
        assert.match(msg, /switch to "chat"/);
        return true;
      },
    );

    // Exactly ONE fetch — the explicit /v1/responses attempt. The
    // provider must NOT fall back to /chat/completions.
    assert.equal(fetchCalls.length, 1, 'no fallback fetch in explicit responses mode');
    assert.ok(fetchCalls[0].url.endsWith('/responses'));
    assert.equal(fetchCalls[0].status, 404);
    // No progress surfaced — the request failed before streaming.
    assert.equal(progress.parts.length, 0, 'no parts reported on 404 error');
    // The explicit-mode decision path was logged.
    assert.ok(
      logged.some((line) => line.includes('Endpoint selected') && line.includes('explicit=true')),
      'logged endpoint selection with explicit=true',
    );
    assert.ok(
      logged.some((line) => line.includes('Explicit /v1/responses 404')),
      'logged explicit 404 decision (no fallback)',
    );
  });

  it('(b) explicit chat + 404 → throws LanguageModelError with hint, no fallback', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    // Per-connection 'chat' is ALWAYS explicit (task spec point 1).
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
    });
    global.fetch = fetch404On('/chat/completions');

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [userMsg('hi')],
          { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      (err: unknown) => {
        assert.ok(err instanceof vscode.LanguageModelError, 'throws LanguageModelError');
        assert.equal((err as vscode.LanguageModelError).code, 'NotFound');
        const msg = (err as Error).message;
        assert.match(msg, /Endpoint \/chat\/completions returned 404 for connection "cloud"/);
        assert.match(msg, /You have explicitly chosen this endpoint/);
        assert.match(msg, /Set "ollamaCloud.preferredEndpoint" to "auto"/);
        assert.match(msg, /switch to "responses"/);
        return true;
      },
    );

    // Exactly ONE fetch — the explicit /chat/completions attempt. No
    // fallback to /v1/responses.
    assert.equal(fetchCalls.length, 1, 'no fallback fetch in explicit chat mode');
    assert.ok(fetchCalls[0].url.endsWith('/chat/completions'));
    assert.equal(fetchCalls[0].status, 404);
    assert.equal(progress.parts.length, 0, 'no parts reported on 404 error');
    assert.ok(
      logged.some((line) => line.includes('Endpoint selected') && line.includes('explicit=true')),
      'logged endpoint selection with explicit=true',
    );
    assert.ok(
      logged.some((line) => line.includes('Explicit /chat/completions 404')),
      'logged explicit 404 decision (no fallback)',
    );
  });

  it('(c) auto + 404 → falls back to chat and logs the auto-mode decision', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    // Per-connection 'auto' with NO explicitly-configured global
    // preferredEndpoint → inherits the default → auto mode. The stub's
    // inspect() returns undefined for keys without inspection metadata,
    // so globalPreferredExplicit is false and isPreferredEndpointExplicit
    // is false.
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
    });
    // No _setInspection call → inspect('preferredEndpoint') returns undefined.

    let callCount = 0;
    global.fetch = (async (input: string | URL, _init?: RequestInit) => {
      callCount += 1;
      const url = typeof input === 'string' ? input : input.toString();
      // First call — /v1/responses → 404 (auto default is 'responses').
      // Second call — /chat/completions → success stream.
      const status = callCount === 1 ? 404 : 200;
      fetchCalls.push({ url, status });
      if (status === 404) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"chat answer"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      [userMsg('hi')],
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // Two fetches: /v1/responses (404) then /chat/completions (200) —
    // the prior fallback behaviour is preserved in auto mode.
    assert.equal(callCount, 2, 'auto mode issued a fallback chat fetch');
    assert.ok(fetchCalls[0].url.endsWith('/responses'));
    assert.equal(fetchCalls[0].status, 404);
    assert.ok(fetchCalls[1].url.endsWith('/chat/completions'));
    assert.equal(fetchCalls[1].status, 200);
    // The chat text delta surfaced — fallback succeeded.
    assert.equal(progress.parts.length, 1, 'one text delta reported');
    assert.equal(
      (progress.parts[0] as vscode.LanguageModelTextPart).value,
      'chat answer',
    );
    // Auto mode is non-explicit.
    assert.ok(
      logged.some((line) => line.includes('Endpoint selected') && line.includes('explicit=false')),
      'logged endpoint selection with explicit=false',
    );
    // The auto-mode fallback decision was logged (task spec point 5).
    assert.ok(
      logged.some((line) => line.includes('Auto-mode fallback')),
      'logged the auto-mode fallback decision',
    );
  });

  it('(c2) auto inherits an EXPLICITLY-configured global → treated as explicit, no fallback on 404', async () => {
    // Task spec point 1: per-connection 'auto' inherits the global
    // explicitness. When the user explicitly set the global
    // preferredEndpoint (detected via inspect() globalValue), the
    // inherited choice is explicit — 404 surfaces an error, no fallback.
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
      // The global value the user explicitly configured.
      preferredEndpoint: 'responses',
    });
    vscode.workspace
      .getConfiguration('ollamaCloud')
      ._setInspection('preferredEndpoint', {
        key: 'ollamaCloud.preferredEndpoint',
        defaultValue: 'responses',
        globalValue: 'responses',
      });

    global.fetch = fetch404On('/responses');

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [userMsg('hi')],
          { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      (err: unknown) => {
        assert.ok(err instanceof vscode.LanguageModelError, 'inherits-explicit throws LanguageModelError');
        assert.equal((err as vscode.LanguageModelError).code, 'NotFound');
        assert.match(
          (err as Error).message,
          /Endpoint \/v1\/responses returned 404 for connection "cloud"/,
        );
        return true;
      },
    );

    // Exactly ONE fetch — inherited-explicit does NOT fall back.
    assert.equal(fetchCalls.length, 1, 'no fallback when auto inherits explicit global');
    assert.ok(fetchCalls[0].url.endsWith('/responses'));
  });

  it('(d) local connection → always /chat/completions, no fallback, no error', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    // Local Ollama does not implement /v1/responses. The provider
    // routes directly to /chat/completions regardless of the
    // preferredEndpoint setting (task spec point 4).
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [LOCAL_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'home', type: 'local', baseUrl: LOCAL_URL, preferredEndpoint: 'auto' },
      ],
    });

    let callCount = 0;
    let modelsFetched = false;
    let chatUrl = '';
    global.fetch = (async (input: string | URL, _init?: RequestInit) => {
      callCount += 1;
      const url = typeof input === 'string' ? input : input.toString();
      // Catalog sync — return one local model so the catalog builds a
      // local model entry with connectionId 'home' and id
      // 'ollama-cloud/home/gpt-oss:120b'. The local connection uses the
      // default openaiCompatiblePath (''), so openAiBaseUrl resolves to
      // 'http://localhost:11434' and the catalog fetch hits
      // http://localhost:11434/models — NOT /v1/models. Match /models
      // (covers /v1/models too) so the OpenAI catalog path resolves the
      // model on the first fetch and callCount stays at 2 (catalog +
      // chat). /api/tags serves Ollama's native { models: [...] } shape
      // (parsed by fetchModelIdsFromTagsCatalog) in case that path is
      // exercised; the prior stub returned { data: [...] } there, which
      // the tags parser cannot read.
      if (url.endsWith('/models')) {
        modelsFetched = true;
        return new Response(
          JSON.stringify({ data: [{ id: 'gpt-oss:120b' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/tags')) {
        modelsFetched = true;
        return new Response(
          JSON.stringify({ models: [{ model: 'gpt-oss:120b' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Chat stream — the ONLY endpoint a local request may hit.
      chatUrl = url;
      fetchCalls.push({ url, status: 200 });
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"local answer"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    // Sync the catalog so 'ollama-cloud/home/gpt-oss:120b' resolves to
    // the local connection. Without this, the model is unknown and the
    // provider throws before reaching the endpoint logic.
    await provider.syncModelCatalog(true);
    assert.ok(modelsFetched, 'catalog synced from the local connection');

    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('home/gpt-oss:120b'),
      [userMsg('hi')],
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // Exactly ONE chat fetch — local never attempts /v1/responses and
    // never falls back (it only has one path).
    assert.equal(callCount, 2, 'catalog sync + single chat fetch');
    assert.ok(
      chatUrl.includes('/chat/completions'),
      `expected /chat/completions URL, got ${chatUrl}`,
    );
    assert.ok(
      !chatUrl.includes('/responses'),
      'local must NOT attempt /v1/responses',
    );
    assert.equal(progress.parts.length, 1, 'one text delta reported');
    assert.equal(
      (progress.parts[0] as vscode.LanguageModelTextPart).value,
      'local answer',
    );
    // Local is never treated as explicit (task spec point 4: unaffected).
    assert.ok(
      logged.some((line) => line.includes('isLocal=true')),
      'logged local connection flag',
    );
  });

  /**
   * Issue #40 follow-up — cache-guard path. When the user explicitly
   * chose `responses` AND the capability cache already memoized that
   * endpoint as unavailable for the connection, the explicit-mode
   * error must fire from the cache short-circuit (ZERO live fetches),
   * not from a fresh 404 round-trip. This case isolates the guard at
   * `src/provider.ts` (the `isResponsesKnownUnavailable` branch) from
   * the live-404 path covered by case (a). The fetch stub returns 200
   * on both endpoints so any live fetch would silently succeed —
   * proving the error originates from the cache, not the network.
   */
  it('(e) explicit responses + cached-unavailable → throws with hint, no fetch round-trip', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'responses' },
      ],
    });
    // Populate the capability cache for the cloud connection WITHOUT a
    // live round-trip — directly mark /v1/responses unavailable. The
    // `beforeEach` already cleared the cache, so this is the sole
    // source of the memoized state.
    markResponsesUnavailable('cloud');

    let callCount = 0;
    global.fetch = (async (input: string | URL, _init?: RequestInit) => {
      callCount += 1;
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, status: 200 });
      // Both endpoints return a success stream — if the provider
      // reached the network at all, the request would NOT 404. Any
      // fetch here means the cache guard was bypassed.
      return mockResponse(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [userMsg('hi')],
          { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
      (err: unknown) => {
        assert.ok(err instanceof vscode.LanguageModelError, 'cache-guard throws LanguageModelError');
        assert.equal((err as vscode.LanguageModelError).code, 'NotFound');
        const msg = (err as Error).message;
        assert.match(msg, /Endpoint \/v1\/responses returned 404 for connection "cloud"/);
        assert.match(msg, /You have explicitly chosen this endpoint/);
        return true;
      },
    );

    // The cache short-circuited before any live fetch — ZERO
    // round-trips. This is the defining assertion of the cache-guard
    // path (vs. case (a), which issues exactly one live 404 fetch).
    assert.equal(callCount, 0, 'cache-guard short-circuited with no fetch round-trip');
    assert.equal(fetchCalls.length, 0, 'no fetch calls recorded');
    assert.equal(progress.parts.length, 0, 'no parts reported on cache-guard error');
    // The cache-guard decision was logged, distinct from the live-404
    // log line asserted in case (a).
    assert.ok(
      logged.some((line) => line.includes('Explicit /v1/responses cached-unavailable')),
      'logged the cache-guard decision (no live 404)',
    );
  });
});

/**
 * Issue #41 — Strand 1 (stream lifecycle logging) + Strand 2 (endpoint
 * indicator tooltip). Two suites:
 *   1. Stream lifecycle: `Stream start` / `Stream done` fire on a
 *      successful stream; `Stream error` fires on a failed stream with
 *      `class=...`. Reuses the logger-capture pattern from the Issue
 *      #40 suite above.
 *   2. Tooltip: `provideLanguageModelChatInformation` appends an
 *      `Endpoint:` line for (a) cloud auto, (b) cloud explicit
 *      `responses`, (c) local.
 */
describe('OllamaCloudChatProvider — stream lifecycle logs (Issue #41)', () => {
  let originalFetch: typeof fetch;
  let logged: string[];
  let originalInfo: typeof logger.info;
  let originalError: typeof logger.error;

  beforeEach(() => {
    clearCapabilityCache();
    logged = [];
    originalFetch = global.fetch;
    originalInfo = logger.info.bind(logger);
    originalError = logger.error.bind(logger);
    logger.info = (message: string, ...details: unknown[]): void => {
      logged.push(`${message} ${details.map((d) => JSON.stringify(d)).join(' ')}`);
    };
    logger.error = (message: string, ...details: unknown[]): void => {
      logged.push(`${message} ${details.map((d) => JSON.stringify(d)).join(' ')}`);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.info = originalInfo;
    logger.error = originalError;
    setConfig({});
  });

  it('logs Stream start and Stream done on a successful stream', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
    });

    const chunks = [
      encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'),
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
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // Stream start fires once on the first chunk (ttft logged).
    assert.ok(
      logged.some((line) => line.includes('Stream start:') && line.includes('ttft=')),
      'logged Stream start with ttft on first chunk',
    );
    // Stream done fires once with duration + chunk count.
    assert.ok(
      logged.some((line) => line.includes('Stream done:') && line.includes('duration=') && line.includes('chunks=')),
      'logged Stream done with duration and chunk count',
    );
  });

  it('logs Stream error with class= on a failed stream', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
    });

    // fetch resolves with a 500 — the streaming client raises an
    // HttpError, which runStream logs as `Stream error: ... class=HttpError`.
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await assert.rejects(
      () =>
        provider.provideLanguageModelChatResponse(
          chatInfoFor('gpt-oss:120b'),
          [userMsg('hi')],
          { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
          progress,
          token,
        ),
    );

    // Stream error fires with the error class. HttpError is the
    // expected class for a non-2xx response.
    assert.ok(
      logged.some((line) => line.includes('Stream error:') && line.includes('class=')),
      'logged Stream error with the error class',
    );
  });
});

/**
 * Issue #41 — Strand 2: the model picker tooltip surfaces the
 * effective endpoint (`Endpoint: ...`) so the user can see at a glance
 * whether a model resolves to `/v1/responses`, `/chat/completions`,
 * or the local Ollama path. Asserted for the three cases that matter:
 *   (a) cloud auto (default `preferredEndpoint`) — resolves to /v1/responses
 *   (b) cloud explicit `responses`
 *   (c) local connection — always /chat/completions (local)
 */
describe('OllamaCloudChatProvider — endpoint indicator tooltip (Issue #41)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setConfig({});
  });

  /**
   * Drives `provideLanguageModelChatInformation` and returns the
   * tooltip of the first info item whose id matches `apiModel`.
   */
  async function tooltipFor(
    ctx: vscode.ExtensionContext,
    apiModel: string,
  ): Promise<string> {
    const provider = new OllamaCloudChatProvider(ctx);
    const infos = await provider.provideLanguageModelChatInformation(
      {} as vscode.PrepareLanguageModelChatModelOptions,
      new vscode.CancellationTokenSource().token,
    );
    const match = infos.find((i) => i.id === `ollama-cloud/${apiModel}`);
    assert.ok(match, `info for ${apiModel} present`);
    return match.tooltip ?? '';
  }

  it('(a) cloud auto — tooltip includes Endpoint: auto (resolves to /v1/responses)', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      apiKey: '',
      // Default global preferredEndpoint is 'responses'; connection is 'auto'.
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
    });

    const tooltip = await tooltipFor(ctx, 'gpt-oss:120b');
    // auto resolves against the global default ('responses') and the
    // label surfaces both the auto choice and what it resolves to.
    assert.match(tooltip, /Endpoint: auto \(resolves to \/v1\/responses\)/);
  });

  it('(b) cloud explicit responses — tooltip includes Endpoint: /v1/responses', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      apiKey: '',
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'responses' },
      ],
    });

    const tooltip = await tooltipFor(ctx, 'gpt-oss:120b');
    assert.match(tooltip, /Endpoint: \/v1\/responses/);
  });

  it('(c) local connection — tooltip includes Endpoint: /chat/completions (local)', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    const LOCAL_URL = 'http://localhost:11434';
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL, LOCAL_URL],
      apiKey: '',
      connections: [
        {
          id: 'home',
          type: 'local',
          baseUrl: LOCAL_URL,
          preferredEndpoint: 'auto',
        },
      ],
    });

    // Catalog fetch stub — the local connection's OpenAI catalog path
    // hits `<baseUrl>/models`. Return one model so the catalog builds
    // an entry with connectionId 'home'.
    global.fetch = (async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'llama3.2:latest' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ model: 'llama3.2:latest' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return mockResponse(streamFromChunks([]));
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(ctx);
    await provider.syncModelCatalog(true);

    const infos = await provider.provideLanguageModelChatInformation(
      {} as vscode.PrepareLanguageModelChatModelOptions,
      new vscode.CancellationTokenSource().token,
    );
    const localInfo = infos.find((i) => i.id.includes('home'));
    assert.ok(localInfo, 'local connection model present in info list');
    assert.match(
      localInfo!.tooltip ?? '',
      /Endpoint: \/chat\/completions \(local\)/,
    );
  });

  /**
   * Issue #41 — must-fix regression (Code Reviewer finding #1).
   *
   * When the user changes the global `ollamaCloud.preferredEndpoint`
   * setting (and nothing else — no `baseUrl`, `connections`, `apiKey`
   * change), the `onDidChangeConfiguration` handler must fire the
   * information emitter so VS Code re-queries the tooltip. Without the
   * fix the `preferredEndpoint` branch clears the cache and logs the
   * new endpoint but never calls `.fire()`, so the
   * `Endpoint: auto (resolves to ...)` tooltip line stays stale until
   * some unrelated event (catalog sync, apiKey change) fires the
   * emitter later.
   *
   * The vscode stub's `workspace.onDidChangeConfiguration` returns a
   * no-op and does NOT deliver events to registered listeners, so the
   * test captures the handler the provider registers by monkey-patching
   * `vscode.workspace.onDidChangeConfiguration` for the duration of
   * the test, then invokes it with a synthetic event whose
   * `affectsConfiguration` only returns true for
   * `ollamaCloud.preferredEndpoint`. The provider's own
   * `onDidChangeLanguageModelChatInformation` event is subscribed
   * before the synthetic change; the assertion is that the emitter
   * fired exactly once as a result of the `preferredEndpoint` change.
   */
  it('(d) global preferredEndpoint change fires the information emitter (must-fix #1)', async () => {
    const { ctx } = makeMockContext({ 'ollamaCloud.apiKey': 'sk-test-key' });
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      apiKey: '',
      // Cloud connection is 'auto' → inherits the global setting, so
      // the tooltip's `resolves to ...` line tracks the global value.
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
    });

    // Capture the `onDidChangeConfiguration` listener the provider
    // registers in its constructor. The stub returns a no-op, so we
    // intercept the registration to grab the handler. The vscode
    // types mark `workspace` properties as read-only, so cast through
    // `unknown` to a mutable shape for the test-only monkey-patch.
    let configListener:
      | ((e: { affectsConfiguration(section: string): boolean }) => void)
      | undefined;
    const originalOnDidChange = vscode.workspace.onDidChangeConfiguration;
    const writableWorkspace = vscode.workspace as unknown as {
      onDidChangeConfiguration: typeof vscode.workspace.onDidChangeConfiguration;
    };
    writableWorkspace.onDidChangeConfiguration = ((
      listener: (e: { affectsConfiguration(section: string): boolean }) => void,
    ) => {
      configListener = listener;
      return { dispose: () => undefined };
    }) as typeof vscode.workspace.onDidChangeConfiguration;

    let fired = 0;
    const provider = new OllamaCloudChatProvider(ctx);
    const sub = provider.onDidChangeLanguageModelChatInformation(() => {
      fired += 1;
    });

    // Restore the stub's no-op `onDidChangeConfiguration` so the
    // monkey-patch does not leak past this test.
    writableWorkspace.onDidChangeConfiguration = originalOnDidChange;

    try {
      assert.ok(configListener, 'provider registered a config-change listener');

      // Sanity baseline: the tooltip reflects the default global
      // `preferredEndpoint: 'responses'`. `tooltipFor` awaits the
      // info query, which also drains the constructor's
      // `queueMicrotask(() => emitter.fire())` (line ~193) so the
      // baseline fire is observed and discarded before the regression
      // measurement begins.
      const before = await tooltipFor(ctx, 'gpt-oss:120b');
      assert.match(
        before,
        /Endpoint: auto \(resolves to \/v1\/responses\)/,
        'tooltip reflects the default global preferredEndpoint before the change',
      );
      // Discard the constructor's microtask fire so `fired` measures
      // only the config-change fire under test.
      fired = 0;

      // Simulate the user changing ONLY the global preferredEndpoint
      // setting. The synthetic event's `affectsConfiguration` returns
      // true for `ollamaCloud.preferredEndpoint` and false for every
      // other key — this is the exact case the must-fix targets (no
      // baseUrl/connections/apiKey change to drive the other branch's
      // `.fire()`).
      setConfig({
        baseUrl: BASE_URL,
        allowedBaseUrls: [BASE_URL],
        apiKey: '',
        preferredEndpoint: 'chat',
        connections: [
          { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
        ],
      });
      configListener!({
        affectsConfiguration: (section: string) =>
          section === 'ollamaCloud.preferredEndpoint',
      });

      // The must-fix assertion: the `preferredEndpoint` branch fired
      // the information emitter. Before the fix this was 0 — the bug.
      assert.equal(fired, 1, 'preferredEndpoint change fired the information emitter');

      // And the tooltip now reflects the new resolution.
      const after = await tooltipFor(ctx, 'gpt-oss:120b');
      assert.match(
        after,
        /Endpoint: auto \(resolves to \/chat\/completions\)/,
        'tooltip reflects the new global preferredEndpoint after the change',
      );
    } finally {
      sub.dispose();
    }
  });
});
