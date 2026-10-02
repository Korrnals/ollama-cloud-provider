import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { logger } from '../../src/logger.js';
import {
  convertMessagesToOpenAI,
  convertMessagesToNative,
  convertOpenAIMessagesToNative,
} from '../../src/convert.js';

/**
 * v0220-a (P1, task v0211-p1-filter-off-compaction-inert) — regression
 * pins for the SHIPPED-DEFAULT configuration: contextFilter.level='off'
 * + compaction ON (v0.19.0 default) + auto→native cloud routing.
 *
 * Defect (cascade-verified 2026-10-02): the dispatch gate for the
 * message source was `filterReport !== undefined` alone. At filter
 * `off` that gate is false, so `/v1/responses` and native `/api/chat`
 * converted the RAW VS Code messages while the compaction state
 * machine still ran — summarizer charged, store writes, sticky
 * projections — i.e. on the default configuration compaction burned
 * summarizer tokens for nothing and the context-window relief never
 * materialized on two of three endpoints (only `/chat/completions`
 * consumed the compacted array).
 *
 * The fix routes the wire through the shaped `filteredMessages` array
 * when EITHER the filter ran OR compaction shaped the history (fire or
 * sticky re-apply — array identity), keeping the original VS Code
 * conversion paths byte-for-byte when neither ran.
 *
 * Pins:
 *   (a) filter=off + native: compacted payload on the wire on the fire
 *       turn AND the sticky re-apply turn (checkpoint system message
 *       present, evicted prefix absent, tail present);
 *   (b) filter=off + /v1/responses: same, with the checkpoint folded
 *       into top-level `instructions` (P1-1 converter behaviour);
 *   (c) filter=off + NO compaction fired: byte-identical wire payload
 *       to the pure passthrough (A/B against compaction disabled — the
 *       default-config-below-threshold regression pin).
 *
 * Config note: the vscode stub's `WorkspaceConfiguration.get` is a
 * FLAT store lookup, so the global filter level is pinned via the flat
 * key `'contextFilter.level': 'off'` (mirroring what the provider
 * actually reads at src/provider.ts `globalConfig.get('contextFilter.level', 'off')`).
 * The per-connection `contextFilter` is left unset ('auto' → inherits
 * the global 'off') — the exact shipped-default topology.
 *
 * Fetch topology per URL (mirrors compactionResponses.test.ts):
 *   - `/v1/responses` → the responses dispatch (SSE event stream);
 *   - `/api/chat` + `stream:true` → the native dispatch (ndjson);
 *   - `/api/chat` + `stream:false` → the summarizer (JSON response).
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

/** `event: <type>\ndata: <json>\n\n` — the /v1/responses SSE frame. */
function sseEvent(type: string, json: string): Uint8Array {
  return encode(`event: ${type}\ndata: ${json}\n\n`);
}

function configure(overrides: Record<string, unknown> = {}): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace({
    baseUrl: BASE_URL,
    allowedBaseUrls: [BASE_URL],
    requestTimeoutMs: 120000,
    maxRetries: 0,
    apiKey: '',
    'contextFilter.level': 'off',
    connections: [
      { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'responses' },
    ],
    ...overrides,
  });
}

const storageDirs: string[] = [];
function makeCompactionContext(): vscode.ExtensionContext {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-compaction-off-dispatch-'),
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

// The stub defines a `System` member (value 1) that the official
// `@types/vscode` enum does not declare — same cast trick as
// `compactionResponses.test.ts`. A leading system message keeps parity
// with the P1-1 pins (checkpoint = SECOND system message, the shape
// the /v1/responses hoist used to drop).
function systemMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: 1 as unknown as vscode.LanguageModelChatMessageRole,
    content: [new vscode.LanguageModelTextPart(text)] as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

// Vision test images — raw header bytes of png / jpeg (mirrors
// unifiedVision.test.ts). Small bytes keep the suites fast; the
// compaction threshold is driven by the PADDED text turns.
const IMG_A = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMG_B = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];

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

/** The bare base64 native `/api/chat` expects in `images[]`. */
function base64Of(bytes: number[]): string {
  return Buffer.from(new Uint8Array(bytes)).toString('base64');
}

// Vision tests use kimi-k3 (snapshot: imageInput TRUE, window
// 1048576) — the vision-capable primary sees the image RAW on the
// first send (ArchCom variant (v)). ~640k chars per padded turn ≈
// 160k tokens at 4 chars/token; 7 turns ≈ 1.12M tokens > the 75% fire
// threshold (786432) of kimi-k3's window. Sizing mirrors
// unifiedVision.test.ts (G2 gate).
const PAD_VISION = 640_000;

/** 7 padded turns + a LAST image turn (recency) — fire + image kept. */
function visionHistory(): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [systemMsg('You are a coding assistant.')];
  for (let i = 1; i <= 7; i++) {
    msgs.push(userMsg(`turn${i} ` + 'x'.repeat(PAD_VISION)));
    msgs.push(assistantMsg('ok'));
  }
  msgs.push(imageMsg(IMG_A, 'what is this?'));
  return msgs;
}

function makeProgress(): vscode.Progress<vscode.LanguageModelResponsePart> {
  return { report: () => undefined };
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

let summarizerCalls: RecordedCall[] = [];
let nativeCalls: RecordedCall[] = [];
let responsesCalls: RecordedCall[] = [];
let logged: string[] = [];

function installFetch(): void {
  summarizerCalls = [];
  nativeCalls = [];
  responsesCalls = [];
  global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const urlStr = String(url);
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (urlStr.includes('/v1/responses')) {
      responsesCalls.push({ url: urlStr, body: parsed });
      return new Response(
        streamFromChunks([
          sseEvent('response.output_text.delta', '{"delta":"ok","item_id":"m1"}'),
          sseEvent(
            'response.completed',
            '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
          ),
        ]),
        { status: 200 },
      );
    }
    if (urlStr.includes('/api/chat') && parsed.stream === true) {
      nativeCalls.push({ url: urlStr, body: parsed });
      return new Response(
        streamFromChunks([
          encode('{"message":{"content":"ok"}}\n'),
          encode('{"done":true}\n'),
        ]),
        { status: 200 },
      );
    }
    if (urlStr.includes('/api/chat')) {
      // Summarizer (`nativeChatOnce`, `stream:false`).
      summarizerCalls.push({ url: urlStr, body: parsed });
      return new Response(
        JSON.stringify({ message: { content: 'CHECKPOINT SUMMARY' } }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const PAD = 36_000;

/** Same growth shape as `compactionResponses.test.ts` (fire + sticky). */
function bigHistory(extraTurns = 0): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [systemMsg('You are a coding assistant.')];
  for (let i = 1; i <= 12 + extraTurns; i++) {
    msgs.push(userMsg(`turn${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  return msgs;
}

async function runTurn(
  provider: OllamaCloudChatProvider,
  messages: vscode.LanguageModelChatRequestMessage[],
  apiModel = 'gpt-oss:120b',
): Promise<void> {
  await provider.provideLanguageModelChatResponse(
    chatInfoFor(apiModel),
    messages,
    { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
    makeProgress(),
    new vscode.CancellationTokenSource().token,
  );
}

describe('compaction reaches the wire at filter=off — v0220-a P1 pins', function () {
  // Full provider dispatch per turn (SSRF guard DNS + SSE pipeline) —
  // same remedy as `compactionResponses.test.ts` under suite load.
  this.timeout(20000);

  let originalFetch: typeof fetch;
  let originalInfo: typeof logger.info;

  beforeEach(() => {
    clearCapabilityCache();
    configure();
    originalFetch = global.fetch;
    originalInfo = logger.info.bind(logger);
    logged = [];
    logger.info = (message: string, ...details: unknown[]): void => {
      logged.push(`${message} ${details.map((d) => JSON.stringify(d)).join(' ')}`);
    };
    installFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logger.info = originalInfo;
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) responses + filter=off: checkpoint in instructions on the fire turn AND the sticky re-apply turn', async () => {
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    // --- Call 1: compaction FIRES at filter=off (the shipped default).
    //     Before v0220-a the dispatch gate was `filterReport !==
    //     undefined` — false at `off` — so the summarizer was charged
    //     (assert below) but the raw history went on the wire.
    await runTurn(provider, bigHistory());
    assert.equal(summarizerCalls.length, 1, 'call 1: compaction fired at filter=off');
    assert.equal(responsesCalls.length, 1, 'call 1: /v1/responses dispatched');
    // The filter itself must NOT have run at `off` (level semantics
    // untouched) — the wire was shaped by the COMPACTION arm of the
    // gate, not the filter arm.
    assert.ok(
      logged.some((line) => line.includes('Compaction check:')),
      'call 1: compaction check line fired',
    );
    assert.ok(
      !logged.some((line) => line.includes('Context filter:')),
      'call 1: no Context filter log at level=off',
    );

    const body1 = responsesCalls[0]!.body as { instructions?: string; input: unknown[] };
    assert.ok(body1.instructions !== undefined, 'call 1: instructions present');
    assert.ok(
      body1.instructions!.startsWith('You are a coding assistant.'),
      'call 1: real system prompt still leads instructions',
    );
    assert.ok(
      body1.instructions!.includes('[compacted-turns'),
      'call 1: checkpoint marker folded into instructions',
    );
    assert.ok(
      body1.instructions!.includes('CHECKPOINT SUMMARY'),
      'call 1: checkpoint summary body folded into instructions',
    );
    const input1 = JSON.stringify(body1.input);
    assert.ok(!input1.includes('turn01'), 'call 1: evicted turn01 absent from input');
    assert.ok(input1.includes('turn12'), 'call 1: recency tail present in input');

    // --- Call 2: SAME provider instance, grown tail, inside the
    //     cooldown — the sticky projection is RE-APPLIED (no second
    //     summarizer charge) and must STILL shape the wire at `off`.
    await runTurn(provider, bigHistory(8));
    assert.equal(summarizerCalls.length, 1, 'call 2: NO second summarizer call (cooldown-held)');
    assert.equal(responsesCalls.length, 2, 'call 2: /v1/responses dispatched');

    const body2 = responsesCalls[1]!.body as { instructions?: string; input: unknown[] };
    assert.ok(
      body2.instructions !== undefined && body2.instructions.includes('[compacted-turns'),
      'call 2 (sticky re-apply): checkpoint still folded into instructions',
    );
    assert.ok(
      body2.instructions!.includes('CHECKPOINT SUMMARY'),
      'call 2 (sticky re-apply): checkpoint summary body present',
    );
    const input2 = JSON.stringify(body2.input);
    assert.ok(!input2.includes('turn01'), 'call 2: evicted prefix stays evicted');
    assert.ok(input2.includes('turn20'), 'call 2: grown tail appended');
  });

  it('(a) native + filter=off: checkpoint as a system message on the fire turn AND the sticky re-apply turn', async () => {
    // P3-a — `preferredEndpoint: 'auto'` (the shipped default): for a
    // cloud connection it resolves to native /api/chat, and the turn
    // runs in AUTO mode (404 → fallback), not explicit mode — the
    // exact default topology the defect shipped in. An explicit
    // 'native' would pin the same message source but different
    // 404-fallback semantics.
    configure({
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
    });
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    // --- Call 1: fire turn. Native is the cloud DEFAULT endpoint
    //     (auto → native) — the exact shipped-default topology.
    await runTurn(provider, bigHistory());
    assert.equal(summarizerCalls.length, 1, 'call 1: compaction fired at filter=off');
    assert.equal(nativeCalls.length, 1, 'call 1: native dispatch');
    assert.ok(nativeCalls[0]!.url.endsWith('/api/chat'), 'call 1: routed to /api/chat');
    assert.ok(
      !logged.some((line) => line.includes('Context filter:')),
      'call 1: no Context filter log at level=off',
    );

    const messages1 = nativeCalls[0]!.body.messages as Array<{ role: string; content: unknown }>;
    assert.ok(
      messages1.some(
        (m) => m.role === 'system' && String(m.content).includes('[compacted-turns'),
      ),
      'call 1 (native): checkpoint present as a system message',
    );
    assert.ok(
      messages1.some(
        (m) => m.role === 'system' && String(m.content).includes('CHECKPOINT SUMMARY'),
      ),
      'call 1 (native): checkpoint summary body present',
    );
    assert.ok(
      !JSON.stringify(messages1).includes('turn01'),
      'call 1 (native): evicted turn01 absent',
    );
    assert.ok(
      JSON.stringify(messages1).includes('turn12'),
      'call 1 (native): recency tail present',
    );

    // --- Call 2: sticky re-apply — checkpoint still a system message.
    await runTurn(provider, bigHistory(8));
    assert.equal(summarizerCalls.length, 1, 'call 2: no second summarizer call');
    assert.equal(nativeCalls.length, 2, 'call 2: native dispatch');
    const messages2 = nativeCalls[1]!.body.messages as Array<{ role: string; content: unknown }>;
    assert.ok(
      messages2.some(
        (m) => m.role === 'system' && String(m.content).includes('[compacted-turns'),
      ),
      'call 2 (native, sticky re-apply): checkpoint still a system message',
    );
    assert.ok(
      !JSON.stringify(messages2).includes('turn01'),
      'call 2 (native): evicted prefix stays evicted',
    );
    assert.ok(
      JSON.stringify(messages2).includes('turn20'),
      'call 2 (native): grown tail present',
    );
  });

  it('(c) filter=off + NO compaction fired: JSON-normalized wire payload identical to the pure passthrough (responses + native, text and image histories)', async () => {
    // A/B pin: run the SAME small history (below the compaction
    // threshold — no fire, no sticky projection) twice, once with
    // compaction disabled (definitionally the original conversion
    // path) and once with the shipped default (ON). The dispatched
    // bodies must compare equal after JSON.stringify normalization —
    // before v0220-a this held only because the `off` gate routed both
    // runs to the original converters; the fix must preserve it via
    // the identity signal (a passthrough `maybeCompact` returns the
    // SAME array reference, so the shaped-path branch stays closed).
    // This is the regression pin for default users who never hit the
    // threshold.
    //
    // P2 — the IMAGE leg makes the pin a real detector for the
    // incident class: the text-only converter pairs are structurally
    // equivalent, so an identity-signal regression alone would flip
    // run B to the shaped converter with an equal body. On the image
    // leg (native endpoint) the legacy converter carries `images[]`;
    // if the gate regresses (copy-on-passthrough) AND the shaped
    // converter regresses on images (the P1 defect class), run B loses
    // the `images[]` array and the bodies diverge. Note the honest
    // post-P1 limitation: with the shaped converter FIXED, both paths
    // are payload-equivalent (pinned by the converter-equivalence test
    // below), so this leg detects the compound regression, not a
    // lone copy-on-passthrough.
    const textHistory = () => [
      systemMsg('You are a coding assistant.'),
      userMsg('hello world'),
      assistantMsg('hi'),
      userMsg('bye'),
    ];
    const imageHistory = () => [
      systemMsg('You are a coding assistant.'),
      userMsg('hello world'),
      imageMsg(IMG_A, 'what is this?'),
      assistantMsg('a png header'),
      userMsg('bye'),
    ];

    for (const [name, history, endpoints, apiModel] of [
      ['text', textHistory, ['responses', 'native'] as const, 'gpt-oss:120b'],
      // The image leg needs a VISION-capable model (kimi-k3) or the
      // vision gate blocks the request before dispatch.
      ['image', imageHistory, ['native'] as const, 'kimi-k3'],
    ] as const) {
      for (const endpoint of endpoints) {
        // Run A — compaction explicitly disabled.
        configure({
          'compaction.enabled': false,
          connections: [
            { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: endpoint },
          ],
        });
        installFetch();
        {
          const provider = new OllamaCloudChatProvider(makeCompactionContext());
          await runTurn(provider, history(), apiModel);
        }
        assert.equal(summarizerCalls.length, 0, `${endpoint}/${name}: run A — no summarizer call`);
        const callsA = endpoint === 'responses' ? responsesCalls : nativeCalls;
        assert.equal(callsA.length, 1, `${endpoint}/${name}: run A dispatched once`);

        // Run B — shipped default (compaction ON), same history: under
        // the threshold → passthrough → the normalized wire payload
        // must not move.
        configure({
          connections: [
            { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: endpoint },
          ],
        });
        installFetch();
        {
          const provider = new OllamaCloudChatProvider(makeCompactionContext());
          await runTurn(provider, history(), apiModel);
        }
        assert.equal(summarizerCalls.length, 0, `${endpoint}/${name}: run B — no summarizer call`);
        const callsB = endpoint === 'responses' ? responsesCalls : nativeCalls;
        assert.equal(callsB.length, 1, `${endpoint}/${name}: run B dispatched once`);

        assert.strictEqual(
          JSON.stringify(callsB[0]!.body),
          JSON.stringify(callsA[0]!.body),
          `${endpoint}/${name}: filter=off below threshold — identical JSON-normalized wire payload`,
        );
        if (name === 'image') {
          // Both runs must actually CARRY the image (an A/B over two
          // equally-blind paths would pass vacuously): the native body
          // has a user message whose `images[]` holds the bare base64.
          const body = callsB[0]!.body as {
            messages: Array<{ role: string; images?: string[] }>;
          };
          assert.ok(
            body.messages.some(
              (m) =>
                m.role === 'user' &&
                Array.isArray(m.images) &&
                m.images.includes(base64Of(IMG_A)),
            ),
            `${endpoint}/${name}: run B carries the image in images[] (bare base64)`,
          );
        }
      }
    }
  });

  it('(P1) shaped native converter is payload-equivalent to the legacy one for image-carrying histories', async () => {
    // Converter-level equivalence pin (no provider dispatch): for the
    // same VS Code history, `convertOpenAIMessagesToNative` over the
    // OpenAI conversion must deep-equal `convertMessagesToNative`.
    // Before v0220-a P1 the shaped converter SKIPPED `image_url`
    // parts (debug log only), so this comparison failed on any
    // image-carrying user message — the native wire lost the image on
    // every shaped dispatch (filter safe/aggressive since ADR 0007;
    // the shipped defaults since the v0220-a dispatch gate).
    const history = [
      systemMsg('You are a coding assistant.'),
      userMsg('hello world'),
      imageMsg(IMG_A, 'what is this?'),
      imageMsg(IMG_B, ''), // image-only user message (empty-text guard parity)
      assistantMsg('a png header'),
      userMsg('bye'),
    ];
    assert.deepStrictEqual(
      convertOpenAIMessagesToNative(convertMessagesToOpenAI(history)),
      convertMessagesToNative(history),
      'shaped and legacy native converters must be payload-equivalent (images in images[])',
    );
    // And the equivalence is not vacuous: the legacy output carries
    // BOTH images on their user messages.
    const legacy = convertMessagesToNative(history);
    const withImages = legacy.filter(
      (m) => Array.isArray(m.images) && m.images.length > 0,
    );
    assert.equal(withImages.length, 2, 'both image user messages carry images[]');
    assert.ok(withImages[0]!.images!.includes(base64Of(IMG_A)));
    assert.ok(withImages[1]!.images!.includes(base64Of(IMG_B)));
  });

  it('(P1) native + filter=off + compaction fire: image in recency reaches the wire in images[] (raw first send)', async () => {
    // The exact defect topology from the review: default config
    // (filter off + compaction ON + auto→native), a vision-capable
    // primary (kimi-k3), a large text history over the 75% fire
    // threshold with the image turn LAST (recency) — compaction fires,
    // the image survives into the compacted array, shapedMessages is
    // true → convertOpenAIMessagesToNative. Before the P1 fix the
    // image_url part was silently dropped here: the model never saw
    // the screenshot.
    configure({
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
      'visionHistory.mode': 'marker',
    });
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    const history = visionHistory(); // 7 padded turns + image turn
    await runTurn(provider, history, 'kimi-k3');
    assert.equal(summarizerCalls.length, 1, 'compaction fired at filter=off');
    assert.equal(nativeCalls.length, 1, 'native dispatch');
    assert.ok(nativeCalls[0]!.url.endsWith('/api/chat'), 'routed to /api/chat');

    const messages = nativeCalls[0]!.body.messages as Array<{
      role: string;
      content: unknown;
      images?: string[];
    }>;
    // The image rides the wire: a user message with `images[]`
    // holding the BARE base64 (data-URL prefix stripped, mirroring
    // `toNativeImageBase64` on the legacy path).
    const imageMessage = messages.find(
      (m) => m.role === 'user' && Array.isArray(m.images) && m.images.length > 0,
    );
    assert.ok(imageMessage, 'user message carries images[] on the shaped native path');
    assert.ok(
      imageMessage!.images!.includes(base64Of(IMG_A)),
      'images[] holds the bare base64 of the screenshot',
    );
    assert.ok(
      !JSON.stringify(nativeCalls[0]!.body).includes('data:image/png;base64,'),
      'data-URL prefix stripped (native wants bare base64)',
    );
    // Compaction shaped this payload: evicted early turn gone, tail
    // kept, checkpoint present — the image coexists with the compacted
    // projection on the wire.
    const wire = JSON.stringify(messages);
    assert.ok(!wire.includes('turn01 '), 'evicted padded turn absent');
    assert.ok(wire.includes('what is this?'), 'image-turn text kept (recency)');
    assert.ok(
      messages.some(
        (m) => m.role === 'system' && String(m.content).includes('[compacted-turns'),
      ),
      'checkpoint system message present alongside the image',
    );
  });

  it('(P1) native + filter=off, marker turn: repeated image becomes its marker, a NEW image rides raw in images[]', async () => {
    // Continuation of the raw-first-send test on the SAME provider:
    // turn 2 re-sends the committed image (lifecycle substitutes the
    // duplicate marker — no pixel re-upload) and attaches a NEW image
    // (first send → raw). Both converter paths must carry this
    // correctly; the assertions hold whichever path the (opaque)
    // hysteresis picks for turn 2.
    configure({
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
      ],
      'visionHistory.mode': 'marker',
    });
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    // Turn 1: commit hash A (stream resolves → hash committed).
    await runTurn(provider, visionHistory(), 'kimi-k3');
    assert.equal(nativeCalls.length, 1, 'turn 1: native dispatch');

    // Turn 2: same history (image A now a duplicate → marker) + a new
    // user turn carrying image B (first send → raw).
    const grown = [
      ...visionHistory(),
      imageMsg(IMG_B, 'and what is THIS?'),
      assistantMsg('ok'),
      userMsg('final question'),
    ];
    await runTurn(provider, grown, 'kimi-k3');
    assert.equal(nativeCalls.length, 2, 'turn 2: native dispatch');

    const wire2 = JSON.stringify(nativeCalls[1]!.body);
    // The repeated image A is substituted by its in-band marker —
    // its pixels must NOT ride the wire again (D408 inflation fix).
    assert.ok(
      wire2.includes('duplicate of an image already sent'),
      'turn 2: repeated image replaced by the lifecycle marker',
    );
    const messages2 = nativeCalls[1]!.body.messages as Array<{
      role: string;
      images?: string[];
    }>;
    const imageMessage2 = messages2.find(
      (m) => m.role === 'user' && Array.isArray(m.images) && m.images.length > 0,
    );
    assert.ok(imageMessage2, 'turn 2: new image rides images[] (raw first send)');
    assert.ok(
      imageMessage2!.images!.includes(base64Of(IMG_B)),
      'turn 2: images[] holds the bare base64 of the NEW image',
    );
    assert.ok(
      !imageMessage2!.images!.includes(base64Of(IMG_A)),
      'turn 2: repeated image A did not re-enter images[]',
    );
    assert.ok(
      !wire2.includes('data:image/png;base64,'),
      'turn 2: data-URL prefixes stripped',
    );
  });
});
