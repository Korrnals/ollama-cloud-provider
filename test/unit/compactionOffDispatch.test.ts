import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { logger } from '../../src/logger.js';

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
): Promise<void> {
  await provider.provideLanguageModelChatResponse(
    chatInfoFor('gpt-oss:120b'),
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
    configure({
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'native' },
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

  it('(c) filter=off + NO compaction fired: wire payload byte-identical to the pure passthrough (responses + native)', async () => {
    // A/B pin: run the SAME small history (below the compaction
    // threshold — no fire, no sticky projection) twice, once with
    // compaction disabled (definitionally the original conversion
    // path) and once with the shipped default (ON). The dispatched
    // bodies must be byte-identical — before v0220-a this held only
    // because the `off` gate routed both runs to the original
    // converters; the fix must preserve it via the identity signal
    // (a passthrough `maybeCompact` returns the SAME array reference,
    // so the shaped-path branch stays closed). This is the regression
    // pin for default users who never hit the threshold.
    const smallHistory = [
      systemMsg('You are a coding assistant.'),
      userMsg('hello world'),
      assistantMsg('hi'),
      userMsg('bye'),
    ];

    for (const endpoint of ['responses', 'native'] as const) {
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
        await runTurn(provider, smallHistory);
      }
      assert.equal(summarizerCalls.length, 0, `${endpoint}: run A — no summarizer call`);
      const callsA = endpoint === 'responses' ? responsesCalls : nativeCalls;
      assert.equal(callsA.length, 1, `${endpoint}: run A dispatched once`);

      // Run B — shipped default (compaction ON), same history: under
      // the threshold → passthrough → wire must not move a byte.
      configure({
        connections: [
          { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: endpoint },
        ],
      });
      installFetch();
      {
        const provider = new OllamaCloudChatProvider(makeCompactionContext());
        await runTurn(provider, smallHistory);
      }
      assert.equal(summarizerCalls.length, 0, `${endpoint}: run B — no summarizer call`);
      const callsB = endpoint === 'responses' ? responsesCalls : nativeCalls;
      assert.equal(callsB.length, 1, `${endpoint}: run B dispatched once`);

      assert.strictEqual(
        JSON.stringify(callsB[0]!.body),
        JSON.stringify(callsA[0]!.body),
        `${endpoint}: filter=off below threshold — byte-identical wire payload`,
      );
    }
  });
});
