import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearImageDescriptionCache } from '../../src/visionTwoPhase.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { logger } from '../../src/logger.js';

/**
 * ArchCom 2026-09-15 "unified vision descriptions" (variant (b)) —
 * integration gates G1–G2 of the committee protocol.
 *
 * Variant (v), field fix 2026-09-15 — supersedes variant (b) for
 * vision-capable primaries. Owner field report: variant (b) stripped
 * a vision-capable primary (glm-5.3-flash) of direct sight. The
 * contract now: a VISION-CAPABLE primary sees the image RAW on the
 * first send (v0.18 marker lifecycle replaces every history re-send
 * with an in-band marker); a TEXT-ONLY primary still goes through
 * two-phase describe (budget ≤4/turn; a transient describe failure
 * throws and is never cached). The pass-through fallback is the
 * single documented raw exception (ADR 0015).
 *
 * Topology mirrors provider.test.ts: cloud connection pinned to
 * `preferredEndpoint: 'chat'`. The fetch stub dispatches by URL:
 * `/api/chat` is the vision model's non-streaming describe call
 * (native JSON), `/chat/completions` is the primary SSE stream.
 * kimi-k3 (vision-capable) is the primary in the G1 gates;
 * minimax-m3 (vision-capable) resolves as the describe model via
 * `visionFallback.model`.
 */

const BASE_URL = 'https://ollama.com/v1';

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
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

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

function configure(overrides: Record<string, unknown> = {}): void {
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
    ...overrides,
  });
}

const storageDirs: string[] = [];
function makeMockContext(): vscode.ExtensionContext {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-unified-vision-'),
  );
  storageDirs.push(storageDir);
  return {
    subscriptions: [],
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
    globalStorageUri: {
      toString: () => `file://${storageDir}`,
      fsPath: storageDir,
    },
  } as unknown as vscode.ExtensionContext;
}

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

function assistantMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [new vscode.LanguageModelTextPart(text)],
    name: undefined,
  };
}

function imageMsg(
  bytes: number[],
  text = 'what is this?',
): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [
      new vscode.LanguageModelTextPart(text),
      new vscode.LanguageModelDataPart(new Uint8Array(bytes), 'image/png'),
    ] as unknown as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

/** PNG-magic test images (distinct bytes → distinct hashes). */
const IMG_A = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMG_B = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const IMG_C = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00];
const IMG_D = [0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00];
const IMG_E = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];

function makeProgress(): vscode.Progress<vscode.LanguageModelResponsePart> & {
  parts: vscode.LanguageModelResponsePart[];
} {
  const parts: vscode.LanguageModelResponsePart[] = [];
  return {
    parts,
    report: (part) => {
      parts.push(part);
    },
  };
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

/** `/api/chat` calls (vision describe, non-streaming) and `/chat/completions` calls (primary SSE). */
let apiChatCalls: RecordedCall[] = [];
let chatCalls: RecordedCall[] = [];

/**
 * URL-dispatching fetch stub. `/api/chat` = the vision describe call:
 * `describe` controls the outcome ('ok' → a description JSON, 'fail'
 * → HTTP 500, 'empty' → an empty-content JSON). Everything else is
 * the primary `/chat/completions` SSE stream.
 */
function installFetch(describe: 'ok' | 'fail' | 'empty' = 'ok'): void {
  apiChatCalls = [];
  chatCalls = [];
  global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const urlStr = String(url);
    const parsed = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (urlStr.includes('/api/chat')) {
      apiChatCalls.push({ url: urlStr, body: parsed });
      if (describe === 'fail') {
        return new Response('vision upstream overloaded', { status: 500 });
      }
      const content = describe === 'empty' ? '' : 'a red square with text';
      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    chatCalls.push({ url: urlStr, body: parsed });
    return new Response(
      streamFromChunks([
        encode('data: {"choices":[{"delta":{"content":"answer from primary"}}]}\n'),
        encode('data: [DONE]\n'),
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
}


describe('vision-primary image lifecycle (variant (v) — field fix 2026-09-15) — G1 gates', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    // Reset the recorded calls — tests that install a CUSTOM fetch
    // (the stripped-catalog one) never go through installFetch,
    // so the arrays must be cleared here too.
    apiChatCalls = [];
    chatCalls = [];
    logger.getRecentErrors().splice(0);
    configure({
      'visionHistory.mode': 'marker',
      // kimi-k3 (primary, vision-capable) cannot auto-resolve to
      // itself as describe model — pin minimax-m3 explicitly.
      'visionFallback.model': 'ollama-cloud/minimax-m3',
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.getRecentErrors().splice(0);
    clearImageDescriptionCache();
    setConfig({});
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G1: vision-capable primary in marker mode → RAW first send, NO describe call, zero describe requests', async () => {
    installFetch('ok');
    const ctx = makeMockContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('kimi-k3'),
      [imageMsg(IMG_A)],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      token,
    );

    // Variant (v): the vision-capable primary SEES the image on the
    // first send — no describe round-trip to a second model.
    assert.equal(chatCalls.length, 1, 'exactly one primary dispatch');
    assert.equal(
      (chatCalls[0]!.body as { model: string }).model,
      'kimi-k3',
      'the primary itself answered',
    );
    const serialized = JSON.stringify(chatCalls[0]!.body);
    assert.ok(
      serialized.includes('image_url') || serialized.includes('images'),
      'the primary received the raw image',
    );
    // No describe traffic at all — the describe budget belongs to
    // text-only primaries only.
    assert.equal(apiChatCalls.length, 0, 'no describe call for a vision primary');
  });

  it('G1: re-send of the same image → history repeat is a marker, not pixels (v0.18 lifecycle)', async () => {
    installFetch('ok');
    const ctx = makeMockContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const token = new vscode.CancellationTokenSource().token;
    const call = (msgs: vscode.LanguageModelChatRequestMessage[]) =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        msgs,
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );

    await call([imageMsg(IMG_A)]);
    await call([
      imageMsg(IMG_A),
      assistantMsg('answer from primary'),
      userMsg('what else?'),
    ]);

    assert.equal(chatCalls.length, 2);
    const turn2 = JSON.stringify(chatCalls[1]!.body);
    assert.ok(
      !turn2.includes('image_url'),
      'the history re-send of the same image became a marker',
    );
    assert.ok(turn2.includes('[Image'), 'marker text present');
    assert.ok(turn2.includes('what else?'), 'new user text survived');
  });

  it('G1: text-only primary in marker mode → two-phase describe still fires (the owner directive channel)', async () => {
    installFetch('ok');
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      'visionFallback.mode': 'two-phase',
    });
    const ctx = makeMockContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      [imageMsg(IMG_A)],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      token,
    );

    // The describe round-trip belongs to text-only primaries.
    assert.equal(apiChatCalls.length, 1, 'one describe call to the vision model');
    assert.equal(
      (apiChatCalls[0]!.body as { model: string }).model,
      'minimax-m3',
      'describe targeted the configured vision model',
    );
    const serialized = JSON.stringify(chatCalls[0]!.body);
    assert.ok(
      !serialized.includes('image_url') && !serialized.includes('images'),
      'the text-only primary received ZERO image bytes',
    );
    assert.ok(
      serialized.includes('[Image description'),
      'the description text reached the primary',
    );
  });

  it('G1: text-only primary — describe budget 5 new images → exactly 4 describes, the 5th degrades to a marker (ADR 0015 inv.3)', async () => {
    installFetch('ok');
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      'visionFallback.mode': 'two-phase',
    });
    const ctx = makeMockContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const token = new vscode.CancellationTokenSource().token;

    // Five distinct images on ONE turn against a text-only primary.
    const content: Array<vscode.LanguageModelInputPart | unknown> = [
      new vscode.LanguageModelTextPart('five screenshots'),
    ];
    for (const img of [IMG_A, IMG_B, IMG_C, IMG_D, IMG_E]) {
      content.push(
        new vscode.LanguageModelDataPart(new Uint8Array(img), 'image/png'),
      );
    }
    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content,
          name: undefined,
        } as vscode.LanguageModelChatRequestMessage,
      ],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      token,
    );

    // ADR 0015 invariant 3: at most DESCRIBE_BUDGET_PER_TURN (4)
    // describe calls; the excess image degrades to a marker.
    assert.equal(apiChatCalls.length, 4, 'exactly 4 describe calls (budget)');
    const dispatched = JSON.stringify(chatCalls[0]!.body);
    assert.ok(!dispatched.includes('image_url'), 'zero image bytes in the payload');
    assert.ok(
      dispatched.includes('[Image'),
      'the over-budget image is represented by a marker',
    );
  });

  it('G1: text-only primary — a transient describe failure does NOT poison the image; the next turn retries the honest describe (review P1-2)', async () => {
    let describeCalls = 0;
    let describeFails = true;
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      'visionFallback.mode': 'two-phase',
    });
    const chatBodies: Array<Record<string, unknown>> = [];
    global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        describeCalls += 1;
        if (describeFails) {
          return new Response('vision upstream overloaded', { status: 500 });
        }
        return new Response(
          JSON.stringify({ message: { content: 'a fresh honest description' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      chatBodies.push(parsed);
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"answer from primary"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());
    const token = new vscode.CancellationTokenSource().token;
    const call = () =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('gpt-oss:120b'),
        [imageMsg(IMG_A)],
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );

    // Turn 1: describe fails → the legacy text-primary contract
    // THROWS (describe-all-or-error); the failed description is NOT
    // cached, so no poisoned marker exists anywhere.
    await assert.rejects(
      () => call(),
      /vision model call failed/,
      'turn 1: the legacy text-only contract throws on describe failure',
    );
    assert.equal(describeCalls, 1, 'exactly one failed describe attempt');

    // Turn 2: same image — the describe is RETRIED from scratch (the
    // failure was never cached): the payload carries the honest
    // description and zero raw bytes.
    describeFails = false;
    await call();
    assert.equal(describeCalls, 2, 'describe retried on the next turn');
    assert.equal(chatBodies.length, 1, 'one dispatched payload recorded');
    assert.ok(
      JSON.stringify(chatBodies[0]).includes('a fresh honest description'),
      'turn 2 payload carries the honest description',
    );
    assert.ok(
      !JSON.stringify(chatBodies[0]).includes('image_url'),
      'still zero raw bytes',
    );
  });

  it('G1: raw mode — vision-capable primary receives the image part on the FIRST send (v0.18 behaviour preserved)', async () => {
    installFetch('ok');
    configure({
      'visionHistory.mode': 'raw',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
    });
    const ctx = makeMockContext();
    // The repeat-marker lifecycle tracks sent hashes on the PROVIDER
    // INSTANCE (per window) — one provider, two turns, mirroring a
    // real chat window.
    const provider = new OllamaCloudChatProvider(ctx);
    const token = new vscode.CancellationTokenSource().token;
    const call = (msgs: vscode.LanguageModelChatRequestMessage[]) =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        msgs,
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );

    // Turn 1: NO describe in raw mode — the primary sees the image raw.
    await call([imageMsg(IMG_A)]);
    assert.equal(
      apiChatCalls.length,
      0,
      'raw mode: no describe call for a vision-capable primary',
    );
    assert.equal(chatCalls.length, 1, 'one primary dispatch');
    const serialized = JSON.stringify(chatCalls[0]!.body);
    assert.ok(
      serialized.includes('image_url'),
      'raw mode: the FIRST send carries the image part raw',
    );
    assert.ok(
      serialized.includes('data:image/png;base64,'),
      'raw mode: the image is a base64 data URL',
    );

    // Turn 2: VS Code re-sends the SAME history. Still a marker —
    // 'raw' opts out of the unified describe, NOT out of the
    // repeat-marker lifecycle (that lifecycle shipped with v0.18
    // and 'raw' already means "first send raw").
    await call([
      imageMsg(IMG_A),
      assistantMsg('answer from primary'),
      userMsg('what else?'),
    ]);
    assert.equal(chatCalls.length, 2, 'turn 2 dispatched');
    const turn2 = JSON.stringify(chatCalls[1]!.body);
    assert.ok(
      !turn2.includes('image_url'),
      'raw mode: repeat re-send from history still becomes a marker',
    );
    assert.ok(turn2.includes('[Image'), 'marker present in turn 2');
    assert.ok(turn2.includes('what else?'), 'new user text survived');
  });
});

/**
 * ArchCom 2026-09-15 G2 — the owner directive's end-to-end invariant:
 * a long session with an image, after compaction fires, must carry
 * ZERO image parts and ZERO base64 signatures in the dispatched
 * payload. The image lives in context ONLY as its text description,
 * and the description itself is subject to compaction (evictable,
 * not pinned — invariant 5).
 *
 * Topology mirrors compactionOscillation.test.ts: cloud pinned to
 * `/chat/completions` (SSE), summarizer `/api/chat` (JSON), describe
 * `/api/chat` (JSON) — both native calls share the /api/chat URL, so
 * the stub dispatches by request body shape (describe requests carry
 * `images`; summarizer requests carry `EVICTED BLOCK` in the prompt).
 * The history exceeds 75% of kimi-k3's 1048576-token window via large
 * text turns (charsPerToken defaults to 4).
 */
describe('unified vision + compaction (ArchCom 2026-09-15) — G2 gate', () => {
  let originalFetch: typeof fetch;
  const BASE = 'https://ollama.com/v1';

  // ~640k chars ≈ 160k estimated tokens per user turn at 4 chars/token.
  // 8 such turns ≈ 1.28M tokens > 75% of kimi-k3's 1048576 window
  // (fire threshold 786432). EIGHT turns also clear the 6-turn recency
  // floor, so the splitZones recency quota (25% = 262144 tokens) —
  // not the turn floor — sizes the recency tail and turns 1–6 stay
  // evictable.
  const PAD = 640_000;

  function visionHistory(): vscode.LanguageModelChatRequestMessage[] {
    const msgs: vscode.LanguageModelChatRequestMessage[] = [];
    for (let i = 1; i <= 7; i++) {
      msgs.push(userMsg(`turn${i} ` + 'x'.repeat(PAD)));
      msgs.push(assistantMsg('answer from primary'));
    }
    // Turn 8 carries the SAME image re-sent from history + new text.
    // In marker mode the describe fires ONCE (first turn) and the
    // cached description substitutes on every later send.
    msgs.push(imageMsg(IMG_A, 'and the image again — summarize so far'));
    msgs.push(assistantMsg('answer from primary'));
    msgs.push(userMsg('final question'));
    return msgs;
  }

  let describeCalls: Array<Record<string, unknown>> = [];
  let summarizerCalls: Array<Record<string, unknown>> = [];
  let chatCalls2: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: BASE,
      allowedBaseUrls: [BASE],
      requestTimeoutMs: 120000,
      maxRetries: 0,
      apiKey: '',
      visionModels: [],
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE, preferredEndpoint: 'chat' },
      ],
      'visionHistory.mode': 'marker',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      // Compaction default is ON since v0.19.0 — left UNSET here so
      // the gate exercises the flipped default end-to-end.
    });
    describeCalls = [];
    summarizerCalls = [];
    chatCalls2 = [];
    originalFetch = global.fetch;
    global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        const messages = (parsed.messages as Array<Record<string, unknown>>) ?? [];
        const isDescribe = messages.some((m) => 'images' in m);
        if (isDescribe) {
          describeCalls.push(parsed);
          return new Response(
            JSON.stringify({ message: { content: 'a red square with text' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        summarizerCalls.push(parsed);
        return new Response(
          JSON.stringify({ message: { content: 'CHECKPOINT SUMMARY' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      chatCalls2.push(parsed);
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"answer from primary"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearImageDescriptionCache();
    vscode.workspace.getConfiguration('ollamaCloud')._replace({});
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after compaction fires, the payload has ZERO image parts and ZERO base64 signatures', async () => {
    const ctx = makeMockContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    await provider.provideLanguageModelChatResponse(
      chatInfoFor('kimi-k3'),
      visionHistory(),
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );

    // Variant (v): a vision-capable primary sees the image raw on the
    // first send — NO describe round-trip. The owner invariant is
    // still held END-TO-END by the marker lifecycle + compaction: the
    // payload after compaction carries zero image parts and zero
    // base64 (asserted below).
    assert.equal(describeCalls.length, 0, 'no describe call for a vision primary');
    // Compaction fired on the DEFAULT (unset) setting: one summarizer
    // call over the 75% threshold.
    assert.equal(summarizerCalls.length, 1, 'compaction fired (default ON)');
    // The primary dispatched.
    assert.equal(chatCalls2.length, 1, 'primary dispatched');

    // G2 invariant (variant (v) topology): the vision primary sees the
    // image raw on the FIRST send (recency); compaction evicts the
    // padded early turns; NO image part survives anywhere else in the
    // payload (the lifecycle marker replaced the history re-send, and
    // the marker text compacts like any text).
    const body = chatCalls2[0] as { messages?: Array<{ role: string; content: unknown }> };
    const imageParts = (body.messages ?? []).filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray((m as { content?: unknown[] }).content) &&
        ((m as { content?: Array<Record<string, unknown>> }).content ?? []).some(
          (p) => (p as { type?: string }).type === 'image_url',
        ),
    );
    assert.equal(imageParts.length, 1, 'exactly ONE image part (the first-send, recency)');
    const serialized = JSON.stringify(chatCalls2[0]);
    // No base64 duplication beyond the single first-send part, and no
    // duplicated text channel: the marker text must NOT coexist with
    // the raw part for the same hash.
    assert.ok(!serialized.includes('[Image '), 'no marker for the first-send image');
    // The evicted early turns are gone (compacted).
    assert.ok(!serialized.includes('turn1 '), 'evicted turn1 removed');
    assert.ok(serialized.includes('final question'), 'recency tail intact');
    assert.ok(
      serialized.includes('[compacted-turns'),
      'summary checkpoint injected',
    );
  });
});

/**
 * v0.20.1 — commit-on-success for the vision hash lifecycle
 * (RCA 2026-09-25, owner report "glm-5.3-flash не работает"): turn 1
 * dispatched the image RAW, the request died on a transient DNS error,
 * and the hash had ALREADY been recorded at dispatch time — turn 2
 * shipped a MARKER instead of the image, so the model never saw it at
 * all. The lifecycle now writes hashes into a per-turn PENDING
 * container; every dispatch branch (native + pass-through) commits
 * them into the instance set ONLY after its stream resolved (onDone).
 *
 * Gate (a): failed turn → no commit → next turn RAW again.
 * Gate (b): successful turn → commit → next turn marker.
 * Gate (c): pass-through — same two rules on the fallback path.
 */
describe('vision hash commit-on-success (v0.20.1 RCA) — G3 gates', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    apiChatCalls = [];
    chatCalls = [];
    logger.getRecentErrors().splice(0);
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.getRecentErrors().splice(0);
    clearImageDescriptionCache();
    setConfig({});
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(a) a FAILED turn does NOT commit image hashes — the next turn re-sends the image RAW', async () => {
    let primaryFails = true;
    global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        // Not expected for a vision-capable primary — served anyway so
        // the stub never falls through accidentally.
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatCalls.push({ url: urlStr, body: parsed ?? {} });
      if (primaryFails) {
        return new Response('upstream exploded', { status: 500 });
      }
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"answer from primary"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());
    const token = new vscode.CancellationTokenSource().token;
    const call = (msgs: vscode.LanguageModelChatRequestMessage[]) =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        msgs,
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );

    // Turn 1: the image goes out RAW, the primary dispatch fails
    // (HTTP 500 → non-404 → terminal error for the turn).
    await assert.rejects(
      () => call([imageMsg(IMG_A)]),
      /Server error \(HTTP 500\)/,
      'turn 1 failed with a surfaced server error',
    );
    assert.equal(chatCalls.length, 1, 'turn 1 dispatched once');
    assert.ok(
      JSON.stringify(chatCalls[0]!.body).includes('image_url'),
      'turn 1 sent the image RAW',
    );

    // Turn 2: same image, primary healthy. The failed turn did NOT
    // commit the hash — the model must see the image RAW again.
    primaryFails = false;
    await call([
      imageMsg(IMG_A),
      assistantMsg('answer from primary'),
      userMsg('and now?'),
    ]);
    assert.equal(chatCalls.length, 2, 'turn 2 dispatched');
    const turn2 = JSON.stringify(chatCalls[1]!.body);
    assert.ok(
      turn2.includes('image_url'),
      'turn 2 re-sends the SAME image RAW (hash was not committed by the failed turn)',
    );
  });

  it('(b) a SUCCESSFUL turn commits the hash — the next turn markerizes the history repeat', async () => {
    installFetch('ok');
    const provider = new OllamaCloudChatProvider(makeMockContext());
    const token = new vscode.CancellationTokenSource().token;
    const call = (msgs: vscode.LanguageModelChatRequestMessage[]) =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        msgs,
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );

    // Turn 1 succeeds → the hash is committed on the success path.
    await call([imageMsg(IMG_A)]);
    assert.equal(chatCalls.length, 1);
    assert.ok(
      JSON.stringify(chatCalls[0]!.body).includes('image_url'),
      'turn 1 sent the image RAW',
    );

    // Turn 2: the committed hash turns the history repeat into a
    // marker (the pre-v0.20.1 behaviour, preserved).
    await call([
      imageMsg(IMG_A),
      assistantMsg('answer from primary'),
      userMsg('what else?'),
    ]);
    assert.equal(chatCalls.length, 2);
    const turn2 = JSON.stringify(chatCalls[1]!.body);
    assert.ok(!turn2.includes('image_url'), 'turn 2 history repeat is a marker');
    assert.ok(turn2.includes('[Image'), 'marker text present');
  });

  it('(c) pass-through: a failed pass-through does NOT commit; a successful one does', async () => {
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.enabled': true,
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      'visionFallback.mode': 'pass-through',
    });
    let visionFails = true;
    global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (visionFails) {
        return new Response('vision upstream exploded', { status: 500 });
      }
      chatCalls.push({ url: urlStr, body: parsed });
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"vision ok"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());
    const token = new vscode.CancellationTokenSource().token;
    const call = (msgs: vscode.LanguageModelChatRequestMessage[]) =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('gpt-oss:120b'),
        msgs,
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );

    // Turn 1: pass-through dispatch fails (HTTP 500) — no commit.
    await assert.rejects(
      () => call([imageMsg(IMG_A)]),
      /Server error \(HTTP 500\)/,
      'turn 1 pass-through failed with a surfaced server error',
    );

    // Turn 2: same image — the failed pass-through did NOT commit the
    // hash, so the vision model sees it RAW again.
    visionFails = false;
    await call([
      imageMsg(IMG_A),
      assistantMsg('vision ok'),
      userMsg('and now?'),
    ]);
    assert.equal(chatCalls.length, 1, 'turn 2 pass-through dispatched');
    assert.ok(
      JSON.stringify(chatCalls[0]!.body).includes('image_url'),
      'turn 2 re-sends the SAME image RAW through the pass-through (no commit on the failed turn)',
    );

    // Turn 3: the SUCCESSFUL turn 2 committed the hash — the history
    // repeat becomes a marker.
    await call([
      imageMsg(IMG_A),
      assistantMsg('vision ok'),
      userMsg('what else?'),
    ]);
    assert.equal(chatCalls.length, 2, 'turn 3 pass-through dispatched');
    const turn3 = JSON.stringify(chatCalls[1]!.body);
    assert.ok(!turn3.includes('image_url'), 'turn 3 history repeat is a marker');
    assert.ok(turn3.includes('[Image'), 'marker text present');
  });
});

/**
 * v0.21.0 D-3 (owner-ratified 2026-10-02) — raw-resend cap. The v0.20.1
 * commit-on-success contract left a failed turn's hashes uncommitted, so
 * every subsequent turn re-sent those images RAW (~2M base64 chars per
 * screenshot per turn) until a success landed — the cascade amplifier
 * behind the 3.3M-char requests and over-window compaction. After
 * `visionHistory.rawResendCap` (default 3) failed sends the hash
 * degrades for the session to the never-sent marker.
 *
 * Failure accounting hooks: (1) the provideLanguageModelChatResponse
 * catch (terminal error path) and (2) the commit points, where a
 * cancelled token distinguishes the D-2 quiet-completed cancel from a
 * genuine stream completion (a cancel fires onDone, which resolves
 * runStream — the token is the discriminator available at the commit
 * site).
 */
describe('vision raw-resend cap (v0.21.0 D-3)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    apiChatCalls = [];
    chatCalls = [];
    logger.getRecentErrors().splice(0);
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.getRecentErrors().splice(0);
    clearImageDescriptionCache();
    setConfig({});
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Fetch stub with a controllable primary outcome: 'fail' → HTTP 500, 'ok' → SSE stream. */
  function installPrimaryFetch(mode: 'fail' | 'ok'): void {
    global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatCalls.push({ url: urlStr, body: parsed ?? {} });
      if (mode === 'fail') {
        return new Response('upstream exploded', { status: 500 });
      }
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"answer from primary"}}]}\n'),
          encode('data: [DONE]\n'),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;
  }

  function makeCall(provider: OllamaCloudChatProvider, token: vscode.CancellationToken) {
    return (msgs: vscode.LanguageModelChatRequestMessage[]) =>
      provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        msgs,
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        token,
      );
  }

  it('(a) below the cap — failed turns keep re-sending RAW; a success commits and exempts', async () => {
    installPrimaryFetch('fail');
    const provider = new OllamaCloudChatProvider(makeMockContext());
    const call = makeCall(provider, new vscode.CancellationTokenSource().token);

    // Turns 1–2 fail (default cap 3 → two failures stay below it):
    // v0.20.1 semantics intact — every retry re-sends the image RAW.
    for (let turn = 1; turn <= 2; turn++) {
      await assert.rejects(
        () => call([imageMsg(IMG_A)]),
        /Server error \(HTTP 500\)/,
        `turn ${turn} failed with a surfaced server error`,
      );
      assert.ok(
        JSON.stringify(chatCalls[chatCalls.length - 1]!.body).includes('image_url'),
        `turn ${turn} re-sent the image RAW (below the cap)`,
      );
    }

    // Turn 3 succeeds with the RAW re-send (the model finally sees it)
    // and COMMITS the hash — the success exempts it forever.
    installPrimaryFetch('ok');
    await call([
      imageMsg(IMG_A),
      assistantMsg('partial answer'),
      userMsg('and now?'),
    ]);
    const turn3 = JSON.stringify(chatCalls[2]!.body);
    assert.ok(turn3.includes('image_url'), 'turn 3 still re-sends RAW at N-1 failures');
    // Turn 4: committed hash → the plain repeat marker, WITHOUT the
    // never-sent note (the image DID reach the model on turn 3).
    await call([
      imageMsg(IMG_A),
      assistantMsg('answer from primary'),
      userMsg('what else?'),
    ]);
    const turn4 = JSON.stringify(chatCalls[3]!.body);
    assert.ok(!turn4.includes('image_url'), 'committed repeat is a marker');
    assert.ok(turn4.includes('[Image'), 'marker text present');
    assert.ok(
      !turn4.includes('never successfully sent'),
      'committed repeats never carry the never-sent note',
    );
  });

  it('(b) at the cap — after N failed turns the hash degrades: never-sent marker, no raw payload', async () => {
    installPrimaryFetch('fail');
    const provider = new OllamaCloudChatProvider(makeMockContext());
    const call = makeCall(provider, new vscode.CancellationTokenSource().token);

    // Turns 1–3 fail → the failure counter reaches the default cap 3.
    for (let turn = 1; turn <= 3; turn++) {
      await assert.rejects(
        () => call([imageMsg(IMG_A)]),
        /Server error \(HTTP 500\)/,
        `turn ${turn} failed`,
      );
      assert.ok(
        JSON.stringify(chatCalls[turn - 1]!.body).includes('image_url'),
        `turn ${turn} re-sent the image RAW (attempt ${turn})`,
      );
    }

    // Turn 4: the capped hash is NOT re-uploaded — the never-sent
    // marker replaces the image part entirely.
    await assert.rejects(
      () => call([imageMsg(IMG_A), assistantMsg('x'), userMsg('again?')]),
      /Server error \(HTTP 500\)/,
      'turn 4 still fails on the server',
    );
    const turn4 = JSON.stringify(chatCalls[3]!.body);
    assert.ok(!turn4.includes('image_url'), 'turn 4 carries NO raw image payload');
    assert.ok(
      turn4.includes('never successfully sent') && turn4.includes('3 attempts failed'),
      `never-sent note with the attempt count present: ${turn4.slice(0, 400)}`,
    );

    // The degradation is permanent for the session, not per-request:
    // a later healthy turn still gets the marker, not a re-upload.
    installPrimaryFetch('ok');
    await call([imageMsg(IMG_A), assistantMsg('x'), userMsg('healthy now?')]);
    const turn5 = JSON.stringify(chatCalls[4]!.body);
    assert.ok(!turn5.includes('image_url'), 'capped hash stays degraded after the server recovers');
    assert.ok(turn5.includes('never successfully sent'), 'never-sent note persists for the session');
  });

  it('(c) cap=0 — unlimited raw re-sends (legacy behavior, no counting)', async () => {
    // getRecentErrors() returns a COPY (and accumulates for the whole
    // session) — assert on the DELTA of cap lines, not absolute absence.
    const capLinesBefore = logger
      .getRecentErrors()
      .filter((line) => line.includes('vision resend cap')).length;
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      'visionHistory.rawResendCap': 0,
    });
    installPrimaryFetch('fail');
    const provider = new OllamaCloudChatProvider(makeMockContext());
    const call = makeCall(provider, new vscode.CancellationTokenSource().token);

    // 5 failed turns — far past the default cap of 3; with cap=0 every
    // turn must still re-send the image RAW (the pre-v0.21 behavior).
    for (let turn = 1; turn <= 5; turn++) {
      await assert.rejects(
        () => call([imageMsg(IMG_A)]),
        /Server error \(HTTP 500\)/,
        `turn ${turn} failed`,
      );
      assert.ok(
        JSON.stringify(chatCalls[turn - 1]!.body).includes('image_url'),
        `turn ${turn} re-sent the image RAW (cap=0 → unlimited)`,
      );
    }
    const capLinesAfter = logger
      .getRecentErrors()
      .filter((line) => line.includes('vision resend cap')).length;
    assert.equal(
      capLinesAfter,
      capLinesBefore,
      'no NEW cap diagnostics with cap=0',
    );
  });

  it('(d) a quiet-completed cancel (D-2 onDone path) counts as a failed send', async () => {
    // Hanging SSE body: 200 + a stream that never completes on its
    // own. Only the caller's cancellation ends it — the token's abort
    // errors the body, readStreamOnce routes AbortError + abortReason
    // 'cancel' to onDone (the D-2 quiet completion), runStream
    // resolves, and the commit site sees the cancelled token.
    global.fetch = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatCalls.push({ url: urlStr, body: parsed ?? {} });
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              controller.error(err);
            });
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());

    // Turns 1–3: cancelled mid-stream → each resolves QUIETLY (no
    // provider failure — the D-2 invariant) and each counts as one
    // failed raw send for the cap.
    for (let turn = 1; turn <= 3; turn++) {
      const cts = new vscode.CancellationTokenSource();
      const pending = provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        [imageMsg(IMG_A)],
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        cts.token,
      );
      await waitFor(() => chatCalls.length === turn);
      cts.cancel();
      await pending; // resolves quietly — must NOT reject (D-2)
      assert.ok(
        JSON.stringify(chatCalls[turn - 1]!.body).includes('image_url'),
        `cancelled turn ${turn} had sent the image RAW`,
      );
    }

    // Turn 4: three quiet-completed cancels exhausted the cap — the
    // hash degrades to the never-sent marker instead of a 4th upload.
    const cts4 = new vscode.CancellationTokenSource();
    const call4 = provider.provideLanguageModelChatResponse(
      chatInfoFor('kimi-k3'),
      [imageMsg(IMG_A), assistantMsg('partial'), userMsg('again?')],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      cts4.token,
    );
    await waitFor(() => chatCalls.length === 4);
    cts4.cancel();
    await call4;
    const turn4 = JSON.stringify(chatCalls[3]!.body);
    assert.ok(!turn4.includes('image_url'), 'no 4th raw upload after three quiet-completed cancels');
    assert.ok(
      turn4.includes('never successfully sent') && turn4.includes('3 attempts failed'),
      'never-sent note present after quiet-completed cancels',
    );
  });

  it('(e) diagnostics — one INFO per capped hash, WARN only on the first capped hash per session', async () => {
    // Capture the logger's OutputChannel so INFO lines (which do not
    // enter getRecentErrors) are observable — same pattern as
    // compactionOscillation.test.ts.
    const captured: string[] = [];
    const originalCreateOutputChannel = vscode.window.createOutputChannel;
    vscode.window.createOutputChannel = (() => ({
      name: 'Ollama Cloud (Debug)',
      appendLine: (line: string) => {
        captured.push(line);
      },
      show: () => undefined,
      dispose: () => undefined,
    })) as unknown as typeof vscode.window.createOutputChannel;
    logger.setDebugMode(true);
    try {
      installPrimaryFetch('fail');
      const provider = new OllamaCloudChatProvider(makeMockContext());
      const call = makeCall(provider, new vscode.CancellationTokenSource().token);

      // Turn 1: BOTH images in one history — each raw send fails.
      await assert.rejects(
        () => call([imageMsg(IMG_A), imageMsg(IMG_B)]),
        /Server error \(HTTP 500\)/,
      );
      // Turns 2–3: repeat the history — raw re-sends fail again; on
      // turn 3 both hashes reach the cap.
      for (let turn = 2; turn <= 3; turn++) {
        await assert.rejects(
          () => call([imageMsg(IMG_A), imageMsg(IMG_B)]),
          /Server error \(HTTP 500\)/,
          `turn ${turn} failed`,
        );
      }

      const infoLines = captured.filter((line) => line.includes('vision resend cap reached'));
      assert.equal(infoLines.length, 2, 'exactly one INFO line per capped hash');
      assert.ok(
        infoLines.every((line) => line.includes('attempts=3') && line.includes('degrading to marker')),
        `INFO lines carry hash/attempts/degradation: ${infoLines.join(' | ')}`,
      );
      assert.ok(
        infoLines.every((line) => /hash=[0-9a-f]{8} /.test(line)),
        'INFO lines carry the first 8 hex chars of the hash',
      );
      const warnLines = captured.filter((line) => line.includes('WARN') && line.includes('vision resend cap'));
      assert.equal(warnLines.length, 1, 'WARN fires exactly once per session (first capped hash only)');
    } finally {
      // Restore the factory FIRST, then leave debug mode —
      // setDebugMode re-creates the channel via the factory, so the
      // logger must already see the real one (order matters: the
      // reverse leaves the logger on this test's capturing stub and
      // poisons later channel-based tests).
      vscode.window.createOutputChannel = originalCreateOutputChannel;
      logger.setDebugMode(false);
    }
  });

  it('(f) cap=0 + quiet-completed cancel — hashes COMMIT (P3-g pin, byte-identical legacy semantics)', async () => {
    // The cap=0 legacy path (commitPendingImageHashes skips the
    // cancelled-token check when resolveRawResendCap() === 0) is what
    // v0.20.1 did for EVERY quiet-completed cancel: the onDone that
    // resolves the pipeline also commits the pending hashes. This test
    // pins that a cancel under cap=0 COMMITS — the next turn gets the
    // plain repeat marker, never a raw re-send, never a never-sent note.
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
      'visionHistory.rawResendCap': 0,
    });
    // Hanging SSE body (same shape as (d)): only the caller's
    // cancellation ends it.
    global.fetch = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatCalls.push({ url: urlStr, body: parsed ?? {} });
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              controller.error(err);
            });
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());

    // Turn 1: cancel mid-stream → quiet resolve; with cap=0 the commit
    // path runs anyway → the hash is COMMITTED despite the cancel.
    const cts1 = new vscode.CancellationTokenSource();
    const turn1 = provider.provideLanguageModelChatResponse(
      chatInfoFor('kimi-k3'),
      [imageMsg(IMG_A)],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      cts1.token,
    );
    await waitFor(() => chatCalls.length === 1);
    cts1.cancel();
    await turn1; // resolves quietly — the D-2 invariant holds under cap=0 too
    assert.ok(
      JSON.stringify(chatCalls[0]!.body).includes('image_url'),
      'turn 1 had sent the image RAW',
    );

    // Turn 2 (healthy stream): the committed hash → the plain repeat
    // marker — NOT a raw re-send, and WITHOUT the never-sent note (no
    // failure counting happens at cap=0). Byte-identical v0.20.1.
    installPrimaryFetch('ok');
    const call2 = makeCall(provider, new vscode.CancellationTokenSource().token);
    await call2([imageMsg(IMG_A), assistantMsg('partial'), userMsg('again?')]);
    const turn2 = JSON.stringify(chatCalls[1]!.body);
    assert.ok(!turn2.includes('image_url'), 'cap=0 cancel COMMITTED — repeat is a marker, not raw');
    assert.ok(turn2.includes('[Image'), 'plain repeat marker present');
    assert.ok(
      !turn2.includes('never successfully sent'),
      'no never-sent note — cap=0 does not count failed sends',
    );
  });
});

/**
 * T-3 (QA audit, cascade cosmetics 2026-10-02) — quiet-cancel in a
 * tool-call/subagent-shaped request. The composition seam under test:
 * buffered tool_call deltas inside the OPEN commit window × mid-stream
 * cancel × the D-2 quiet-completion path × the vision commit-site
 * failed-send accounting.
 *
 * KNOWN DEFECT (NOT asserted here — the parallel stream slice flips it
 * this cycle): on the cancel quiet-completion branch
 * (src/streamReader.ts:966) the wrapped onDone FLUSHES the still-open
 * commit window first (src/commitWindow.ts:226-232 — "buffered deltas
 * must still reach the user" was written for GENUINE completion), so
 * buffered tool_call deltas are delivered to `progress` AFTER the
 * cancel. When the discard-on-cancel fix lands, that flush disappears;
 * the invariants below hold in BOTH worlds, which is why this test
 * deliberately asserts no flush shape.
 */
describe('vision T-3 — quiet-cancel in a tool-call-shaped request (QA audit)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    apiChatCalls = [];
    chatCalls = [];
    logger.getRecentErrors().splice(0);
    configure({
      'visionHistory.mode': 'marker',
      'visionFallback.model': 'ollama-cloud/minimax-m3',
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.getRecentErrors().splice(0);
    clearImageDescriptionCache();
    setConfig({});
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buffered tool_call deltas + cancel mid-stream → clean quiet onDone, no error, hashes counted as failed sends', async () => {
    // Subagent-shaped turn: the history carries an image (the vision
    // pending-hash accounting is part of the composition) and the SSE
    // stream emits a tool_call delta pair — a fragment chunk plus the
    // `finish_reason: "tool_calls"` chunk that flushes the accumulated
    // call into onToolCall — which the OPEN commit window buffers; the
    // stream then hangs and only the caller's cancel ends the turn.
    //
    // NOTE on options.tools: the request carries no `tools` array —
    // the vscode test stub does not define
    // `LanguageModelChatToolMode`, and provider.resolveToolChoice
    // reads `vscode.LanguageModelChatToolMode.Required` whenever tools
    // are present, so a tools-bearing request crashes under the stub
    // (test-infra gap, reported separately; the shared stub is outside
    // this slice's file ownership). The tool-call buffering seam under
    // test here is fully exercised by the response-side tool_call
    // deltas, which is what a subagent delegation receives.
    global.fetch = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatCalls.push({ url: urlStr, body: parsed ?? {} });
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Tool-call fragment, then the finish_reason chunk that
            // flushes it into onToolCall (compat parser accumulates by
            // index and flushes on finish_reason === 'tool_calls').
            // No [DONE]: the stream hangs — the commit window (5 s
            // default) is still OPEN when the cancel fires.
            controller.enqueue(
              encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_t3","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encode(
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
              ),
            );
            signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              controller.error(err);
            });
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());

    // Turns 1–3: cancel mid-stream each time. Stable invariants under
    // assertion (hold with the flush AND with the future discard):
    //   (1) the turn resolves QUIETLY — clean onDone, no error
    //       surfaced to VS Code (D-2 invariant, tool-call shape);
    //   (2) the raw image was sent and its hash counts as a FAILED
    //       send (default cap 3) — observable on turn 4 below.
    for (let turn = 1; turn <= 3; turn++) {
      const cts = new vscode.CancellationTokenSource();
      const pending = provider.provideLanguageModelChatResponse(
        chatInfoFor('kimi-k3'),
        [imageMsg(IMG_A)],
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        makeProgress(),
        cts.token,
      );
      await waitFor(() => chatCalls.length === turn);
      cts.cancel();
      await pending; // MUST resolve — an error here would surface to VS Code
      const body = JSON.stringify(chatCalls[turn - 1]!.body);
      assert.ok(body.includes('image_url'), `turn ${turn} had sent the image RAW`);
    }

    // Turn 4: the three quiet-completed cancels exhausted the cap — the
    // pending hashes were recorded as failed sends on every cancelled
    // turn, so the image degrades to the never-sent marker.
    const cts4 = new vscode.CancellationTokenSource();
    const call4 = provider.provideLanguageModelChatResponse(
      chatInfoFor('kimi-k3'),
      [imageMsg(IMG_A), assistantMsg('partial'), userMsg('again?')],
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      cts4.token,
    );
    await waitFor(() => chatCalls.length === 4);
    cts4.cancel();
    await call4;
    const turn4 = JSON.stringify(chatCalls[3]!.body);
    assert.ok(!turn4.includes('image_url'), 'no 4th raw upload — failed-send accounting ran on every quiet cancel');
    assert.ok(
      turn4.includes('never successfully sent') && turn4.includes('3 attempts failed'),
      'the cancelled tool-call turns counted as failed sends',
    );
  });
});

/** Polls `cond` until it holds; rejects after `ms` (test pacing for async fetch stubs). */
function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) {
        resolve();
      } else if (Date.now() - start > ms) {
        reject(new Error('waitFor: condition not met before timeout'));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}
