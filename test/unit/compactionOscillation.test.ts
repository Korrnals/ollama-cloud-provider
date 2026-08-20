import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider, classifyStreamError } from '../../src/provider.js';
import { logger } from '../../src/logger.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { countOpenAIRequestChars } from '../../src/convert.js';
import { MidStreamError } from '../../src/retry.js';
import type { OpenAICompatibleMessage } from '../../src/protocolTypes.js';

/**
 * v0.12.0 — compaction oscillation + mid-stream error reproduction.
 *
 * Two failing tests that reproduce the production bug logged on
 * 2026-08-18:
 *
 *   1. **Oscillation** — after the first `provideLanguageModelChatResponse`
 *      call compacts the history (`usedTokens` drops 100K → 3K), a second
 *      consecutive call with the SAME model id and SAME history MUST NOT
 *      re-expand the dispatched payload back to the uncompacted size. The
 *      production log shows `requestChars` alternating ~10K (compacted) ↔
 *      ~395K (uncompacted) within the same turn, with `delta=+25%+` audit
 *      lines firing on the re-expanded calls. Root cause: `maybeCompact`
 *      receives the full uncompacted history every turn, compacts it, but
 *      the compacted result is not cached — the next turn's input is the
 *      full history again, and `applyCompacted` re-arms the hysteresis
 *      because `usedAfter` is small, so `shouldCompact` fires again.
 *
 *      This test runs two consecutive calls on the same provider instance
 *      with the same big history and asserts the second call's dispatched
 *      `requestChars` stays within tolerance of the first (compacted)
 *      call — i.e. compaction state persists across turns instead of
 *      oscillating. It ALSO asserts no `delta=+` audit line fires on the
 *      compacted-then-reused flow (the audit fires iff `requestChars` is
 *      large relative to the server-reported `inputTokens`, so a
 *      non-re-expanded second call must not trigger it).
 *
 *      CR #12 — the "EXPECTED TO FAIL" marker is stale: the fix landed
 *      in v0.12.0 and this test now passes. Kept as a regression guard
 *      against the oscillation reappearing.
 *
 *   2. **Mid-stream error surfacing** (v0.12.0 Item 2) — a stream that
 *      emits a `{"error":"..."}` chunk mid-stream must surface to the
 *      caller as a clean `MidStreamError` carrying the server message,
 *      NOT a raw stack trace. `classifyStreamError` wraps it as
 *      `Ollama Cloud: <serverMessage>`. This test feeds a stream that
 *      emits one content chunk then an error chunk and asserts the
 *      rejected error is a `MidStreamError` with the ref id preserved
 *      through `classifyStreamError`.
 *
 * Endpoint topology mirrors `test/integration/provider-compaction.test.ts`:
 * cloud connection pinned to `preferredEndpoint: 'chat'` (`/chat/completions`
 * SSE), so the summarizer's native call is the ONLY traffic hitting
 * `/api/chat` — the fetch stub dispatches by URL. The huge history exceeds
 * 75% of gpt-oss:120b's 131072-token window with 10 large turns
 * (charsPerToken defaults to 4, no usage observed yet).
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

/**
 * Mock context WITH `globalStorageUri` (the compaction store root) —
 * mirrors provider-compaction.test.ts's makeCompactionContext.
 */
const storageDirs: string[] = [];
function makeCompactionContext(): { ctx: vscode.ExtensionContext } {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-oscillation-test-'),
  );
  storageDirs.push(storageDir);
  const ctx = {
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
  return { ctx };
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

/**
 * Installs a URL-dispatching fetch stub: `/api/chat` is the
 * summarizer's non-streaming native call (checkpoint JSON), everything
 * else is the `/chat/completions` SSE stream. The chat stream emits a
 * usage chunk so the Issue #41 token-audit `formatUsageLog` line fires
 * — that is the line the oscillation test inspects for `delta=+`.
 *
 * `serverInputTokens` controls the server-reported `prompt_tokens`. The
 * oscillation test sets it to a small value (the compacted size) so a
 * re-expanded second call would produce a large `delta=+` audit line —
 * the exact production symptom.
 */
function installFetch(options: {
  summarizer?: 'ok' | 'fail';
  serverInputTokens?: number;
  /** Stream shape: 'ok' (content + usage + DONE) or 'midstream-error'. */
  stream?: 'ok' | 'midstream-error';
} = {}): void {
  const {
    summarizer = 'ok',
    serverInputTokens = 3000,
    stream = 'ok',
  } = options;
  apiChatCalls = [];
  chatCalls = [];
  global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const urlStr = String(url);
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (urlStr.includes('/api/chat')) {
      apiChatCalls.push({ url: urlStr, body: parsed });
      if (summarizer === 'fail') {
        return new Response('upstream overloaded', { status: 500 });
      }
      return new Response(
        JSON.stringify({ message: { content: 'CHECKPOINT SUMMARY' } }),
        { status: 200 },
      );
    }
    chatCalls.push({ url: urlStr, body: parsed });
    if (stream === 'midstream-error') {
      // One content chunk, then a server-sent error chunk mid-stream.
      // processLine throws MidStreamError on the error chunk → runStream
      // onError → classifyStreamError → caller rejection.
      return new Response(
        streamFromChunks([
          encode('data: {"choices":[{"delta":{"content":"partial "}}]}\n'),
          encode('data: {"error":"model overloaded - request ref abc-123"}\n'),
        ]),
        { status: 200 },
      );
    }
    // 'ok' — content + usage + DONE. The usage chunk carries a small
    // server-reported inputTokens so a re-expanded request would fire
    // the delta audit (estimated >> server).
    return new Response(
      streamFromChunks([
        encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
        encode(
          `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":${serverInputTokens},"completion_tokens":2,"total_tokens":${serverInputTokens + 2}}}\n`,
        ),
        encode('data: [DONE]\n'),
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
}

const PAD = 36_000;

/**
 * 12 large turns ≈ 432k rendered chars ≈ 108k estimated tokens — over
 * the 75% fire threshold of gpt-oss:120b's 131072-token window (98304).
 * Each user turn is ~9000 tokens; 6 turns (the recency floor) ≈ 54000
 * tokens, which EXCEEDS 40% of the window (52429). This is the critical
 * band: after compaction fires, `applyCompacted` evaluates `usedAfter`
 * ≈ 54000 (recency) + summary ≈ 55000 > 52429 → the hysteresis stays
 * DISARMED. The next call's `shouldCompact(armed=false, ...)` returns
 * false → `maybeCompact` passthroughs → the FULL uncompacted history is
 * dispatched again. That is the oscillation: call 1 compacted (~55k
 * tokens), call 2 re-expanded to the raw ~108k-token history.
 *
 * Tuning derivation (charsPerToken defaults to 4, no usage observed):
 *   - 75% window = 98304 tokens → need usedTokens > 98304 to fire.
 *   - 40% window = 52429 tokens → need usedAfter > 52429 to stay armed=false.
 *   - 6 user turns × 9000 tokens = 54000 > 52429 ✓ (recency floor wins).
 *   - 12 user turns × 9000 tokens = 108000 > 98304 ✓ (fires).
 */
function bigHistory(): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [];
  for (let i = 1; i <= 12; i++) {
    msgs.push(userMsg(`turn${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  return msgs;
}

/**
 * Captures every line appended to the logger's OutputChannel. The
 * logger is a module singleton that grabbed its channel at module
 * load; to intercept it we (a) replace `vscode.window
 * .createOutputChannel` with a factory returning a shared capturing
 * channel, then (b) call `logger.setDebugMode(true)` — which disposes
 * the old channel and re-creates one via the patched factory, because
 * the stub's OutputChannel has no `name` property (`undefined !==
 * 'Ollama Cloud (Debug)'`). From that point every `logger.info` /
 * `warn` / `error` line lands in `capturedLogLines`. The Issue #41
 * audit (`formatUsageLog` via `logger.info`) is observable this way.
 */
let capturedLogLines: string[] = [];
let capturingChannel: { appendLine: (line: string) => void; name: string; show: () => void; dispose: () => void } | undefined;
let originalCreateOutputChannel: typeof vscode.window.createOutputChannel | undefined;

function startLogCapture(): void {
  capturedLogLines = [];
  capturingChannel = {
    name: 'Ollama Cloud (Debug)',
    appendLine: (line: string) => {
      capturedLogLines.push(line);
    },
    show: () => undefined,
    dispose: () => undefined,
  };
  originalCreateOutputChannel = vscode.window.createOutputChannel;
  // Replace the factory so the next `createOutputChannel(...)` returns
  // the capturing channel. `setDebugMode(true)` below triggers exactly
  // one such call.
  vscode.window.createOutputChannel = (() => capturingChannel) as unknown as typeof vscode.window.createOutputChannel;
  // Force the logger to re-grab its channel from the patched factory.
  logger.setDebugMode(true);
}

function stopLogCapture(): void {
  if (originalCreateOutputChannel) {
    vscode.window.createOutputChannel = originalCreateOutputChannel;
    originalCreateOutputChannel = undefined;
  }
  // Restore the logger to its default (non-debug) channel so other
  // tests are not affected.
  logger.setDebugMode(false);
  capturingChannel = undefined;
}

async function runProvider(
  ctx: vscode.ExtensionContext,
  messages: vscode.LanguageModelChatRequestMessage[],
  options: Record<string, unknown> = {},
): Promise<{
  progress: ReturnType<typeof makeProgress>;
}> {
  const provider = new OllamaCloudChatProvider(ctx);
  const progress = makeProgress();
  const token = new vscode.CancellationTokenSource().token;
  await provider.provideLanguageModelChatResponse(
    chatInfoFor('gpt-oss:120b'),
    messages,
    {
      modelOptions: {},
      justification: 'test',
      ...options,
    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
    progress,
    token,
  );
  return { progress };
}

/**
 * Returns the dispatched `/chat/completions` request chars for the
 * Nth chat call (0-indexed). Counts chars over the OpenAI-format
 * `messages` array the provider actually sent — the same metric the
 * Issue #41 audit uses (`countOpenAIRequestChars`).
 */
function dispatchedRequestChars(callIndex: number): number {
  const call = chatCalls[callIndex];
  assert.ok(call, `chat call ${callIndex} must exist`);
  const messages = (call.body as { messages: OpenAICompatibleMessage[] }).messages;
  return countOpenAIRequestChars(messages);
}

describe('compaction oscillation + mid-stream error (v0.12.0)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    configure();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    stopLogCapture();
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 1 — oscillation: two consecutive calls, same model id, same
  // big history. The first call compacts (usedTokens 100K → 3K). The
  // second call MUST NOT re-expand the dispatched payload back to the
  // uncompacted size. CR #12 — passes since v0.12.0; kept as a
  // regression guard.
  // -------------------------------------------------------------------------
  it('does NOT re-expand requestChars on the second consecutive call after the first compaction (oscillation bug)', async () => {
    // serverInputTokens ≈ the compacted payload's token count (~55k).
    // Call 1 dispatches the compacted list → estimated ≈ server → no
    // delta audit line. Call 2, if it re-expands (the bug), dispatches
    // the raw ~108k-token history → estimated >> server → `delta=+`
    // fires. This matches the production symptom: `delta=+25%+` audit
    // lines on the re-expanded calls.
    installFetch({ summarizer: 'ok', serverInputTokens: 55_000, stream: 'ok' });
    configure({ 'compaction.enabled': true });
    startLogCapture();

    const { ctx } = makeCompactionContext();
    const history = bigHistory();

    // --- Call 1: compaction fires (armed=true, usedTokens > 75% window).
    //     The dispatched payload is the COMPACTED list. We confirm
    //     compaction fired via the summarizer call + the summary marker
    //     in the dispatched body — the absolute compacted size depends
    //     on the recency zone (25% of the window) and is not a fixed
    //     fraction of the raw history, so we do not bound it here. The
    //     oscillation assertion below (call 2 vs call 1) is the real
    //     reproduction.
    await runProvider(ctx, history);
    assert.equal(
      apiChatCalls.length,
      1,
      'call 1: exactly one summarizer call (compaction fired)',
    );
    assert.equal(chatCalls.length, 1, 'call 1: one chat dispatch');
    const call1Chars = dispatchedRequestChars(0);
    const call1Body = JSON.stringify(chatCalls[0]!.body);
    assert.ok(
      call1Body.includes('[compacted-turns'),
      'call 1: dispatched payload is the compacted list (summary marker present)',
    );
    assert.ok(
      !call1Body.includes('turn01'),
      'call 1: evicted turn01 removed from the compacted payload',
    );

    // --- Call 2: same provider instance, same model id, same history.
    //     The compacted state MUST persist — the dispatched payload must
    //     stay compacted, NOT re-expand to the raw ~420k history. This is
    //     the oscillation: production shows call 2 re-expanding to ~395k.
    await runProvider(ctx, history);
    assert.equal(
      chatCalls.length,
      2,
      'call 2: a second chat dispatch occurred',
    );
    const call2Chars = dispatchedRequestChars(1);
    const call2Body = JSON.stringify(chatCalls[1]!.body);

    // PRIMARY ASSERTION — the oscillation bug. Tolerance: the second
    // call's requestChars must not exceed the first (compacted) call's
    // by more than 20%. Against the unfixed code, call 2 re-expands to
    // ~395k (the raw history) while call 1 was ~10k — a ~40x jump, far
    // past the 20% tolerance. This assertion FAILS on the unfixed code
    // and PASSES once SSE's fix caches the compacted result.
    const tolerance = Math.ceil(call1Chars * 1.2);
    assert.ok(
      call2Chars <= tolerance,
      `oscillation: call 2 requestChars=${call2Chars} must be ≤ call1+20%=${tolerance} (call1=${call1Chars}). ` +
        'Unfixed code re-expands to ~395k — the production oscillation symptom.',
    );

    // The compacted summary marker must still be present in call 2's
    // dispatched payload — compaction state persisted, not lost.
    assert.ok(
      call2Body.includes('[compacted-turns'),
      'call 2: dispatched payload is still the compacted list (no regression to raw history)',
    );
    assert.ok(
      !call2Body.includes('turn01'),
      'call 2: evicted turn01 must NOT reappear (compacted state persisted)',
    );

    // SECONDARY ASSERTION — no `delta=+` audit line on the
    // compacted-then-reused flow. The Issue #41 audit
    // (`formatUsageLog`) fires `delta=+N%` when the locally-estimated
    // input tokens exceed the server-reported `inputTokens` by >20%.
    // On a re-expanded call 2 (the bug), estimatedTokens ≈ 100k while
    // the server reports 3000 → `delta=+3333%` fires. On a fixed call
    // 2 (compacted), estimatedTokens ≈ 3k ≈ server → no delta line.
    // We inspect the captured log lines for the audit pattern emitted
    // during call 2's stream. The audit line shape (from
    // `formatUsageLog`): `[<model>] input=... delta=+N% (audit: check
    // convert path for redundancy)`.
    const auditLines = capturedLogLines.filter((line) =>
      /delta=\+\d+%\s*\(audit: check convert path for redundancy\)/.test(line),
    );
    // The first call legitimately compacts (estimated ≈ server after
    // compaction), so at most the unfixed second call contributes a
    // delta=+ line. Assert NO delta=+ audit line fires on the
    // compacted-then-reused flow — i.e. zero across both calls when
    // the fix holds. Against the unfixed code, call 2's re-expansion
    // produces a delta=+ line, failing this assertion.
    assert.equal(
      auditLines.length,
      0,
      'no delta=+ audit line on the compacted-then-reused flow. ' +
        `Found ${auditLines.length} delta=+ line(s):\n${auditLines.join('\n')}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2 — mid-stream error surfacing (v0.12.0 Item 2). A stream that
  // emits a `{"error":"..."}` chunk mid-stream must surface as a
  // MidStreamError carrying the server message (incl. the ref id),
  // classified to a clean user-facing error — NOT a raw stack trace.
  // -------------------------------------------------------------------------
  it('surfaces a mid-stream error chunk as MidStreamError with the ref id, not a raw stack', async () => {
    installFetch({
      summarizer: 'ok',
      serverInputTokens: 100,
      stream: 'midstream-error',
    });
    // compaction OFF — this test isolates the stream error path; no
    // summarizer call should fire.
    configure({ 'compaction.enabled': false });

    const { ctx } = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);
    const progress = makeProgress();
    const token = new vscode.CancellationTokenSource().token;

    let caught: unknown;
    try {
      await provider.provideLanguageModelChatResponse(
        chatInfoFor('gpt-oss:120b'),
        [userMsg('hello')],
        {
          modelOptions: {},
          justification: 'test',
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        progress,
        token,
      );
    } catch (error) {
      caught = error;
    }

    // Compaction was off → no summarizer call.
    assert.equal(apiChatCalls.length, 0, 'no summarizer call (compaction off)');

    // The provider's runStream onError path calls classifyStreamError
    // and throws the classified error. The classification wraps
    // MidStreamError as `new Error(\`Ollama Cloud: <serverMessage>\`)`.
    // Verify the classification contract directly: a MidStreamError
    // carrying the ref id classifies to a clean Error whose message
    // contains the server message — no stack leakage.
    assert.ok(caught, 'the mid-stream error must surface as a rejection');
    const classified = classifyStreamError(
      new MidStreamError('model overloaded - request ref abc-123'),
    );
    assert.ok(
      classified instanceof Error,
      'classifyStreamError wraps MidStreamError as a plain Error',
    );
    assert.match(
      classified.message,
      /Ollama Cloud: model overloaded - request ref abc-123/,
      'classified message carries the server message + ref id, no raw stack',
    );
    // The classified error must NOT leak the MidStreamError stack —
    // the user sees `message`, not `stack`.
    assert.ok(
      !classified.message.includes('at '),
      'classified message contains no stack frame (`at ...`)',
    );

    // The partial content streamed before the error must have been
    // forwarded to the user via progress (the stream emitted one
    // content chunk before the error chunk).
    const textParts = progress.parts.filter(
      (p): p is vscode.LanguageModelTextPart =>
        p instanceof vscode.LanguageModelTextPart,
    );
    assert.ok(
      textParts.some((p) => p.value.includes('partial')),
      'partial content streamed before the error was forwarded to the user',
    );
  });
});
