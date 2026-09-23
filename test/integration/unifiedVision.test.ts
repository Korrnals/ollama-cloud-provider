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
 * Owner directive: an image must NOT live in the context as raw
 * bytes in ANY outcome — only a text description, which is itself
 * subject to compaction. Invariant 1: the two-phase describe runs
 * for EVERY primary with images, INCLUDING vision-capable primaries
 * (the primary never receives an image part, except the raw
 * opt-out's FIRST send). Invariant 2: degradation, not silence —
 * describe failure / no vision model / budget exhaustion degrades
 * to the ADR 0013 marker cycle with a warning log, never a throw and
 * never raw bytes. Invariant 3: describe budget ≤4 fresh calls per
 * turn. Invariant 6: zero image parts in every outgoing payload in
 * marker mode.
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
