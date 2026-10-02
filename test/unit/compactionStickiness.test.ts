import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { logger } from '../../src/logger.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { countOpenAIRequestChars } from '../../src/convert.js';
import type { OpenAICompatibleMessage } from '../../src/protocolTypes.js';

/**
 * v0.21.0 slice d1 — compaction STICKINESS at the provider wiring level.
 *
 * The production bug (RCA 2026-10-02): VS Code re-sends the FULL
 * immutable chat history on every request; `maybeCompact` compacted the
 * triggering request but the NEXT request passed the raw history
 * through (shouldCompact false during the 5-minute cooldown / below
 * the 75% threshold), whiplashing the model context 380K↔1.1M tokens.
 *
 * Unlike `compactionOscillation.test.ts` (which creates a FRESH
 * provider per call — fresh hysteresis state, so it cannot see the
 * cooldown path), these tests drive ONE provider instance across
 * consecutive `provideLanguageModelChatResponse` calls, exactly like a
 * chat window does:
 *
 *   1. fire on a big history;
 *   2. next request WITHIN the cooldown, history grown past the fire
 *      threshold again → the remembered projection is RE-APPLIED (no
 *      second summarizer call), with the grown tail appended;
 *   3. a request whose history no longer matches the basis (another
 *      conversation on the same model id) → projection dropped, raw
 *      passthrough, chain reset;
 *   4. P3-a rider — the compaction notice is an application/json
 *      LanguageModelDataPart, never assistant text;
 *   5. P3-b rider — the per-request `Compaction check:` INFO line.
 *
 * Endpoint topology mirrors compactionOscillation.test.ts: cloud
 * connection pinned to `preferredEndpoint: 'chat'`; the fetch stub
 * dispatches `/api/chat` (summarizer) separately from the SSE stream.
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
    path.join(os.tmpdir(), 'ocp-stickiness-test-'),
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
 * of gpt-oss:120b's 131072-token window. `extraTurns` appends more
 * large turns (the VS Code tail-growth shape); `tag` distinguishes
 * conversations for the invalidation scenario.
 */
function bigHistory(extraTurns = 0, tag = 'turn'): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [];
  for (let i = 1; i <= 12 + extraTurns; i++) {
    msgs.push(userMsg(`${tag}${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  return msgs;
}

/** Log capture — same channel-swap trick as compactionOscillation.test.ts. */
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

function dispatchedRequestChars(callIndex: number): number {
  const call = chatCalls[callIndex];
  assert.ok(call, `chat call ${callIndex} must exist`);
  const messages = (call.body as { messages: OpenAICompatibleMessage[] }).messages;
  return countOpenAIRequestChars(messages);
}

/** Decodes the P3-a compaction notice data parts. */
function compactionNotices(
  parts: vscode.LanguageModelResponsePart[],
): Array<{ notice: string; beforeTokens: number | null; afterTokens: number | null }> {
  return parts
    .filter(
      (p): p is vscode.LanguageModelDataPart =>
        p instanceof vscode.LanguageModelDataPart && p.mimeType === 'application/json',
    )
    .map(
      (p) =>
        JSON.parse(new TextDecoder().decode(p.data)) as {
          notice: string;
          beforeTokens: number | null;
          afterTokens: number | null;
        },
    )
    .filter((payload) => payload.notice === 'context-compacted');
}

describe('compaction stickiness — provider wiring (v0.21.0 slice d1)', () => {
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

  it('re-applies the projection on the next request within the cooldown (grown tail, no second fire)', async () => {
    startLogCapture();
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const progress1 = makeProgress();
    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      bigHistory(),
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress1,
      new vscode.CancellationTokenSource().token,
    );

    // --- Call 1: compaction fired, compacted payload dispatched.
    assert.equal(apiChatCalls.length, 1, 'call 1: exactly one summarizer call');
    assert.ok(dispatchedBody(0).includes('[compacted-turns'), 'call 1: compacted payload');
    assert.ok(!dispatchedBody(0).includes('turn01'), 'call 1: evicted turn01 removed');

    // --- P3-a rider: the notice is a structured data part, and NO
    //     banner text landed in the assistant text stream.
    const notices = compactionNotices(progress1.parts);
    assert.equal(notices.length, 1, 'call 1: exactly one compaction notice (data part)');
    assert.equal(notices[0]!.notice, 'context-compacted');
    assert.ok(typeof notices[0]!.beforeTokens === 'number' && notices[0]!.beforeTokens > 0);
    assert.ok(
      typeof notices[0]!.afterTokens === 'number' && notices[0]!.afterTokens! < notices[0]!.beforeTokens!,
      'notice carries the before→after reduction',
    );
    assert.ok(
      !progress1.parts.some(
        (p) =>
          p instanceof vscode.LanguageModelTextPart &&
          (p.value.includes('🧠') || p.value.includes('Context compacted')),
      ),
      'P3-a: no compaction banner inside the assistant text stream',
    );

    // --- Call 2: SAME provider instance (same model id state), seconds
    //     later — deep inside the 5-minute cooldown — with the history
    //     grown by 8 more large turns (re-applied usage back OVER the
    //     98304-token threshold: the exact production whiplash setup).
    //     Without stickiness this dispatches the raw ~740k-char
    //     history; with stickiness it re-applies the projection.
    const grown = bigHistory(8);
    const progress2 = makeProgress();
    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      grown,
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress2,
      new vscode.CancellationTokenSource().token,
    );

    assert.equal(apiChatCalls.length, 1, 'call 2: NO second summarizer call (cooldown-held)');
    assert.equal(chatCalls.length, 2, 'call 2: chat dispatched');
    const body2 = dispatchedBody(1);
    assert.ok(body2.includes('[compacted-turns'), 'call 2: re-applied projection served');
    assert.ok(!body2.includes('turn01'), 'call 2: evicted prefix stays evicted');
    assert.ok(body2.includes('turn20'), 'call 2: grown tail appended');
    // Size sanity: the re-applied payload must be far below the raw
    // grown history (~740k chars) — the evicted turns stay evicted.
    const rawGrownChars = grown.reduce(
      (s, m) => s + JSON.stringify(m.content).length,
      0,
    );
    assert.ok(
      dispatchedRequestChars(1) < rawGrownChars * 0.75,
      `call 2 requestChars=${dispatchedRequestChars(1)} must stay well under the raw ${rawGrownChars}`,
    );

    // --- Observability: the distinct re-apply INFO line + the P3-b
    //     per-request check line.
    assert.ok(
      capturedLogLines.some((line) =>
        /Compaction re-applied: projectedTokens=\d+ tailMessages=\d+/.test(line),
      ),
      're-apply INFO line present',
    );
    assert.ok(
      capturedLogLines.some((line) =>
        /Compaction check: usedTokens=\d+ windowTokens=131072 threshold=\d+ charsPerToken=\d+(\.\d+)? armed=\w+ reapply=\w+/.test(
          line,
        ),
      ),
      'P3-b per-request check INFO line present',
    );

    // --- Call 3: a DIFFERENT conversation on the same model id — the
    //     basis no longer matches → projection dropped, raw passthrough
    //     (the cooldown still holds a fresh fire on this fresh machine).
    const progress3 = makeProgress();
    await provider.provideLanguageModelChatResponse(
      chatInfoFor('gpt-oss:120b'),
      bigHistory(0, 'zz'),
      { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress3,
      new vscode.CancellationTokenSource().token,
    );
    assert.equal(apiChatCalls.length, 1, 'call 3: still no new fire (cooldown + reset machine)');
    const body3 = dispatchedBody(2);
    assert.ok(body3.includes('zz01'), 'call 3: raw history passed through');
    assert.ok(!body3.includes('[compacted-turns'), 'call 3: stale projection NOT served to a foreign history');
    assert.ok(
      capturedLogLines.some((line) => line.includes('Compaction projection dropped')),
      'invalidation INFO line present',
    );
  });
});
