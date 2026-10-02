import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { logger } from '../../src/logger.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { countOpenAIRequestChars } from '../../src/convert.js';

/**
 * v0.22.0 (v0220-cc, QA-audit P2) — composition test T-1: the compaction
 * projection basis is VISION-STATE-INDEPENDENT end-to-end.
 *
 * Before the fix, the d1 prefix basis was fingerprinted over the WIRE
 * render (JSON.stringify). Vision-state transitions (raw→marker on the
 * v0.20.1 commit, raw→never-sent-marker on the D-3 cap) change a
 * message's render INSIDE the basis, so the very next turn dropped the
 * projection: one-turn full-history serving (whiplash) plus a
 * cooldown-gated re-fire — self-healing but real.
 *
 * Scenario (one provider instance, vision-capable primary,
 * `visionHistory.mode='raw'`, endpoint /chat/completions):
 *
 *   1. big history; an image rides the FIRST turn (evicted into the
 *      basis on the fire) and another rides the LAST turn (recency,
 *      dispatched RAW on the first send);
 *   2. the stream succeeds → both hashes commit;
 *   3. next turn (inside the cooldown, tail grown): both images now
 *      arrive as markers — the projection must SURVIVE (re-applied, no
 *      reset, no full-history serving, no re-fire), and the marker (not
 *      raw base64) rides the wire.
 *
 * Endpoint topology mirrors compactionStickiness.test.ts.
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

function configure(overrides: Record<string, unknown> = {}): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace({
    baseUrl: BASE_URL,
    allowedBaseUrls: [BASE_URL],
    requestTimeoutMs: 120000,
    maxRetries: 0,
    apiKey: '',
    // First send of each image goes RAW (no two-phase describe) so the
    // raw→marker transition is exercised directly.
    'visionHistory.mode': 'raw',
    // gpt-oss:120b is text-only in the catalog snapshot; an explicit
    // visionModels pattern makes it vision-capable for this test.
    visionModels: ['gpt-oss:120b'],
    connections: [
      { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
    ],
    ...overrides,
  });
}

const storageDirs: string[] = [];
function makeCompactionContext(): vscode.ExtensionContext {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-vision-basis-test-'),
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
    capabilities: { imageInput: true, toolCalling: true },
  } as unknown as vscode.LanguageModelChatInformation;
}

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02]);

function userMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart(text)],
    name: undefined,
  };
}

function imageUserMsg(text: string, png: Uint8Array): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart(text), new vscode.LanguageModelDataPart(png, 'image/png')],
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

function makeProgress(): vscode.Progress<vscode.LanguageModelResponsePart> {
  return { report: () => undefined };
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

let apiChatCalls: RecordedCall[] = [];
let chatCalls: RecordedCall[] = [];

function installFetch(): void {
  apiChatCalls = [];
  chatCalls = [];
  global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const urlStr = String(url);
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (urlStr.includes('/api/chat')) {
      apiChatCalls.push({ url: urlStr, body: parsed });
      return new Response(
        JSON.stringify({ message: { content: 'CHECKPOINT SUMMARY' } }),
        { status: 200 },
      );
    }
    chatCalls.push({ url: urlStr, body: parsed });
    return new Response(
      streamFromChunks([
        encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
        encode('data: [DONE]\n'),
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
}

const PAD = 36_000;

/**
 * 12 large turns ≈ 108k estimated tokens — over the 75% fire threshold
 * of gpt-oss:120b's 131072-token window. Image A rides turn 1 (evicted
 * into the projection basis on the fire); image B rides the LAST turn
 * (recency — dispatched RAW on the first send). `extraTurns` appends
 * more TEXT turns (the VS Code tail-growth shape).
 */
function visionHistory(extraTurns = 0): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [];
  msgs.push(imageUserMsg('vturn01 ' + 'x'.repeat(PAD), PNG_A));
  msgs.push(assistantMsg('ok'));
  for (let i = 2; i <= 11; i++) {
    msgs.push(userMsg(`vturn${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  msgs.push(imageUserMsg('vturn12 ' + 'x'.repeat(PAD), PNG_B));
  msgs.push(assistantMsg('ok'));
  for (let i = 13; i <= 12 + extraTurns; i++) {
    msgs.push(userMsg(`vturn${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  return msgs;
}

let capturedLogLines: string[] = [];
let capturingChannel:
  | { appendLine: (line: string) => void; name: string; show: () => void; dispose: () => void }
  | undefined;
let originalCreateOutputChannel: typeof vscode.window.createOutputChannel | undefined;

function startLogCapture(): void {
  capturedLogLines = [];
  capturingChannel = {
    name: 'Ollama Cloud (Debug)',
    appendLine: (line) => {
      capturedLogLines.push(line);
    },
    show: () => undefined,
    dispose: () => undefined,
  };
  originalCreateOutputChannel = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (() => capturingChannel) as unknown as typeof vscode.window.createOutputChannel;
  logger.setDebugMode(true);
}

function stopLogCapture(): void {
  if (originalCreateOutputChannel) {
    vscode.window.createOutputChannel = originalCreateOutputChannel;
    originalCreateOutputChannel = undefined;
  }
  logger.setDebugMode(false);
  capturingChannel = undefined;
}

function dispatchedBody(callIndex: number): string {
  const call = chatCalls[callIndex];
  assert.ok(call, `chat call ${callIndex} must exist`);
  return JSON.stringify(call.body);
}

describe('compaction vision-basis — T-1 composition (v0220-cc P2)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    configure();
    originalFetch = global.fetch;
    installFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    stopLogCapture();
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('projection computed over a raw image render survives the image committing to a marker', async () => {
    startLogCapture();
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    // --- Call 1: fire over the big history. Image A (turn 1) is evicted
    //     into the projection basis in RAW form; image B (turn 12,
    //     recency) is dispatched RAW on its first send.
    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      visionHistory(),
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      new vscode.CancellationTokenSource().token,
    );
    assert.equal(apiChatCalls.length, 1, 'call 1: exactly one summarizer call (fire)');
    const body1 = dispatchedBody(0);
    assert.ok(body1.includes('[compacted-turns'), 'call 1: compacted payload dispatched');
    assert.ok(!body1.includes('vturn01'), 'call 1: evicted image turn removed');
    assert.ok(body1.includes('data:image'), 'call 1: recency image B rides the wire RAW (first send)');

    // --- Call 2: SAME provider instance, seconds later (deep inside
    //     the 5-minute cooldown), history grown by 2 text turns. Both
    //     raw sends committed on call 1's success, so both images now
    //     arrive as in-band MARKERS — including image A inside the
    //     remembered basis. Before the fix this dropped the projection
    //     (basis fingerprinted over the wire render) and served the
    //     FULL raw history; now the basis is vision-state-independent
    //     and the projection re-applies.
    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      visionHistory(2),
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      makeProgress(),
      new vscode.CancellationTokenSource().token,
    );
    assert.equal(apiChatCalls.length, 1, 'call 2: NO second summarizer call (cooldown-held, no re-fire)');
    assert.equal(chatCalls.length, 2, 'call 2: chat dispatched');
    const body2 = dispatchedBody(1);
    assert.ok(body2.includes('[compacted-turns'), 'call 2: projection SURVIVES the raw→marker flip — re-applied');
    assert.ok(!body2.includes('vturn01'), 'call 2: evicted prefix stays evicted (no full-history serving)');
    assert.ok(body2.includes('vturn14'), 'call 2: grown tail appended');
    assert.ok(!body2.includes('data:image'), 'call 2: NO raw base64 on the wire');
    assert.ok(body2.includes('[Image '), 'call 2: the marker (not raw) rides the wire');

    // Whiplash proxy: the served payload stays far below the raw grown
    // history (~870k chars) — the evicted turns stay evicted.
    const call2 = chatCalls[1]!;
    const messages2 = (call2.body as { messages: { content: unknown }[] }).messages;
    const servedChars = countOpenAIRequestChars(
      messages2 as never,
    );
    assert.ok(
      servedChars < 700_000,
      `call 2 servedChars=${servedChars} must stay far below the raw grown history`,
    );

    // Observability: re-apply happened, projection NOT dropped.
    assert.ok(
      capturedLogLines.some((line) => /Compaction re-applied: projectedTokens=\d+ tailMessages=\d+/.test(line)),
      're-apply INFO line present',
    );
    assert.ok(
      !capturedLogLines.some((line) => line.includes('Compaction projection dropped')),
      'projection NOT dropped across the vision-state transition',
    );
  });
});
