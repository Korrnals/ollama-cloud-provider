import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';
import { clearImageDescriptionCache } from '../../src/visionTwoPhase.js';
import { logger } from '../../src/logger.js';

/**
 * v0221-p2-composition-tests (cascade QA audit of v0.22.0) — the two
 * composition gaps the audit flagged (P2-2) plus its P3 rider. Every
 * PIECE is separately pinned elsewhere (commitWindow.test.ts pins the
 * discard/backoff-cancellation at the reader level; unifiedVision T-3
 * pins discard-on-cancel on a SINGLE-endpoint dispatch; provider.test.ts
 * pins the native 3×404 → chat fallback); these tests pin the
 * COMPOSITIONS that had no coverage:
 *
 *   P2-2 — discard-on-cancel under a 404-FALLBACK CHAIN through the
 *     v0220 endpoint-dispatch seam (buildEndpointAttemptChain +
 *     runStreamAttempt): attempt-1 pre-stream 404 (native, reaching the
 *     3×404 auto-switch threshold) → attempt-2 (chat-final) streams
 *     buffered tool_call deltas then hangs → mid-window cancel →
 *     (a) quiet resolve (no provider failure to VS Code), (b) no
 *     tool-call part emitted after the cancel (window discard),
 *     (c) the turn's pending vision hashes classified FAILED at the
 *     commit site (commitTurn sees the cancelled token →
 *     recordFailedImageSends), observable on the next turn as the
 *     never-sent marker with '3 attempts failed'.
 *
 *   P3 rider — TurnHandle classification under the hidden-retry
 *     BACKOFF-CANCEL path: a CIE inside the OPEN window schedules a
 *     hidden retry (onHiddenRetry already emptied the buffer), the
 *     backoff sleep is interrupted by the caller's cancel → quiet
 *     onDone WITHOUT discard (safe precisely because the buffer is
 *     empty): pin quiet completion, no second POST, NOTHING delivered
 *     from the broken attempt (no double-flush), and failed-send
 *     accounting running at the provider commit site (cap=1 → the next
 *     turn degrades to the never-sent marker instead of re-uploading
 *     raw pixels or serving the committed-duplicate marker).
 *
 * Test patterns follow unifiedVision.test.ts (T-3): provider-level fetch
 * stubs dispatched by URL, waitFor pacing, CancellationTokenSource.
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
      { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'auto' },
    ],
    'visionHistory.mode': 'marker',
    ...overrides,
  });
}

const storageDirs: string[] = [];
function makeMockContext(): vscode.ExtensionContext {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-fallback-cancel-'),
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

const IMG_A = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

function makeCall(provider: OllamaCloudChatProvider) {
  return (
    msgs: vscode.LanguageModelChatRequestMessage[],
    token: vscode.CancellationToken,
    progress: vscode.Progress<vscode.LanguageModelResponsePart> = makeProgress(),
  ) =>
    provider.provideLanguageModelChatResponse(
      chatInfoFor('kimi-k3'),
      msgs,
      {
        modelOptions: {},
        justification: 'test',
      } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
      progress,
      token,
    );
}

/**
 * A SSE body that emits a buffered tool_call delta pair (fragment +
 * the `finish_reason:"tool_calls"` chunk that flushes it into
 * onToolCall — the compat parser accumulates by index and flushes on
 * the finish reason) and then HANGS: no [DONE], no close. Only the
 * caller's cancellation ends it (the abort listener errors the body).
 * While it hangs the commit window (5 s default) is still OPEN — the
 * cancel lands mid-window.
 */
function hangingToolCallBody(signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encode(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_p22","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\n\n',
        ),
      );
      controller.enqueue(
        encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'),
      );
      signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        controller.error(err);
      });
    },
  });
}

describe('P2-2 — discard-on-cancel under a 404 fallback chain (cascade QA audit v0.22.0)', () => {
  let originalFetch: typeof fetch;
  let nativeBodies: Array<Record<string, unknown>>;
  let chatBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    logger.getRecentErrors().splice(0);
    // 'auto' cloud → native primary (the shipped default), AUTO mode
    // (not explicit — the only topology where a 404 falls back).
    configure();
    nativeBodies = [];
    chatBodies = [];
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

  it('native pre-stream 404 (threshold) → chat fallback → mid-window cancel: quiet resolve, no tool-call part after cancel, hashes recorded failed', async function () {
    // Full provider dispatch per turn (SSRF guard DNS + the fallback
    // chain) — same remedy as the other provider-level suites.
    this.timeout(20000);

    global.fetch = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        // Attempt-1 shape: PRE-STREAM 404 (headers only, no body).
        nativeBodies.push(parsed);
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Attempt-2 shape (chat-final): buffered tool_call deltas, then
      // hangs until the caller cancels.
      chatBodies.push(parsed);
      return new Response(hangingToolCallBody(init?.signal), { status: 200 });
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());
    const call = makeCall(provider);

    // Turns 1–2: native pre-stream 404 BELOW the 3×404 threshold —
    // terminal (surfaced, asserted), and each already counts one FAILED
    // raw send via the outer catch (recordFailedTurn).
    for (let turn = 1; turn <= 2; turn++) {
      await assert.rejects(
        () => call([imageMsg(IMG_A)], new vscode.CancellationTokenSource().token),
        /not found/,
        `turn ${turn}: below-threshold native 404 is terminal (no fallback yet)`,
      );
      assert.ok(
        JSON.stringify(nativeBodies[turn - 1]).includes(
          Buffer.from(new Uint8Array(IMG_A)).toString('base64'),
        ),
        `turn ${turn}: the image went out RAW on the native attempt`,
      );
    }

    // Turn 3 — the composition under test: the third native 404 reaches
    // the 3×404 threshold → markNativeChatUnavailable → the dispatch
    // chain CONTINUES to chat-final (attempt-2 through the seam), which
    // streams buffered tool_call deltas and hangs; the user cancels
    // MID-WINDOW.
    const cts3 = new vscode.CancellationTokenSource();
    const progress3 = makeProgress();
    const turn3 = call([imageMsg(IMG_A)], cts3.token, progress3);
    // 8s window: the awaited chain spans two DNS-resolving fetches
    // (native 404 + the chat fallback); under first-run suite load the
    // 2s default flaked (run-35 RCA). The 5s commit window is unaffected
    // — it arms on the first delta AFTER the chat fetch lands, and the
    // cancel follows within one 10ms poll tick.
    await waitFor(() => chatBodies.length === 1, 8000);
    cts3.cancel();
    await turn3; // MUST resolve quietly — a rejection would surface to VS Code

    assert.equal(nativeBodies.length, 3, 'attempt-1 was the third native pre-stream 404');
    assert.equal(chatBodies.length, 1, 'attempt-2 was the chat fallback dispatch');
    assert.ok(
      JSON.stringify(chatBodies[0]).includes('image_url'),
      'the chat-fallback attempt carried the image RAW (the pending hash exists)',
    );
    // Discard: the tool_call deltas sat in the OPEN commit window when
    // the cancel fired — nothing may reach the host after the cancel
    // (a flushed LanguageModelToolCallPart would be a ghost tool call
    // in a dead turn).
    const leakedToolCalls = progress3.parts.filter(
      (p) => p instanceof vscode.LanguageModelToolCallPart,
    );
    assert.strictEqual(
      leakedToolCalls.length,
      0,
      'cancel-caused completion must not deliver buffered tool_call parts',
    );
    assert.equal(
      progress3.parts.filter((p) => p instanceof vscode.LanguageModelTextPart).length,
      0,
      'no error/notice text surfaced on the quiet cancel either',
    );

    // Turn 4: turns 1–2 (terminal 404s, outer catch) + turn 3
    // (quiet-completed cancel INSIDE the fallback chain) = 3 failed raw
    // sends → the default cap 3 is reached. The never-sent marker with
    // '3 attempts failed' proves the CANCELLED fallback turn's pending
    // hashes were classified FAILED at the commit site (commitTurn with
    // a cancelled token → recordFailedImageSends), NOT committed (the
    // committed outcome serves the plain duplicate marker) and not
    // skipped (that outcome re-uploads raw pixels).
    const cts4 = new vscode.CancellationTokenSource();
    const call4 = call(
      [imageMsg(IMG_A), assistantMsg('partial'), userMsg('again?')],
      cts4.token,
    );
    await waitFor(() => chatBodies.length === 2, 8000);
    cts4.cancel();
    await call4;
    const turn4 = JSON.stringify(chatBodies[1]);
    assert.ok(
      !turn4.includes('image_url'),
      'no 4th raw upload — the quiet-completed cancel inside the fallback chain counted as a failed send',
    );
    assert.ok(
      turn4.includes('never successfully sent') && turn4.includes('3 attempts failed'),
      'failed-send accounting ran on the cancelled fallback turn (commit-site classification)',
    );
  });
});

describe('P3 rider — hidden-retry backoff-cancel: quiet onDone, no double-flush, failed-send accounting (cascade QA audit v0.22.0)', () => {
  let originalFetch: typeof fetch;
  let originalRandom: () => number;

  beforeEach(() => {
    clearCapabilityCache();
    clearImageDescriptionCache();
    logger.getRecentErrors().splice(0);
    // Single-endpoint topology (chat-primary — no fallback in play): the
    // seam under test is the streamReader backoff × cancel × the
    // provider commit-site classification. cap=1 makes ONE failed send
    // observable as the never-sent marker on the next turn.
    configure({
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
      ],
      'visionHistory.rawResendCap': 1,
    });
    originalFetch = global.fetch;
    // Pin the hidden-retry jitter factor to exactly 1.0
    // (0.75 + 0.5 * 0.5) → the backoff sleep is exactly 1000 ms
    // (same pin as commitWindow.test.ts).
    originalRandom = Math.random;
    Math.random = () => 0.5;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Math.random = originalRandom;
    logger.getRecentErrors().splice(0);
    clearImageDescriptionCache();
    setConfig({});
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancel during the backoff sleep → quiet completion, no second POST, nothing delivered (no double-flush), hashes recorded failed', async function () {
    this.timeout(10000);

    let chatFetches = 0;
    let stream1Errored = false;
    let serveHealthy = false;
    const chatBodies: Array<Record<string, unknown>> = [];
    global.fetch = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      const urlStr = String(url);
      const parsed = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      if (urlStr.includes('/api/chat')) {
        // Not expected (vision-capable primary, marker mode) — served so
        // the stub never falls through accidentally.
        return new Response(JSON.stringify({ message: { content: 'unused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatFetches += 1;
      chatBodies.push(parsed);
      if (serveHealthy) {
        return new Response(
          streamFromChunks([
            encode('data: {"choices":[{"delta":{"content":"healthy answer"}}]}\n\n'),
            encode('data: [DONE]\n\n'),
          ]),
          { status: 200 },
        );
      }
      // Attempt 1: one text delta (buffered in the OPEN 5 s window),
      // then a raw ECONNRESET 20 ms in → reclassified to
      // ConnectionInterruptedError (chunks > 0, not an idle kill) →
      // hidden retry SCHEDULED (onHiddenRetry empties the buffer) with
      // an exactly-1000 ms backoff (jitter pinned).
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encode('data: {"choices":[{"delta":{"content":"partial prefix"}}]}\n\n'),
            );
            setTimeout(() => {
              stream1Errored = true;
              const err = new Error('read ECONNRESET');
              (err as { code?: string }).code = 'ECONNRESET';
              controller.error(err);
            }, 20);
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new OllamaCloudChatProvider(makeMockContext());
    const call = makeCall(provider);

    // Turn 1: the image goes out RAW; the stream breaks inside the open
    // window; the hidden retry is scheduled; the user cancels DURING
    // the backoff sleep.
    const cts = new vscode.CancellationTokenSource();
    const progress = makeProgress();
    const turn1 = call([imageMsg(IMG_A)], cts.token, progress);
    // 8s window: the fetch (and its DNS resolve) precedes the 20ms
    // stream break this waits for — same first-run load margin as P2-2.
    await waitFor(() => stream1Errored, 8000);
    const cancelledAt = Date.now();
    cts.cancel();
    await turn1; // MUST resolve quietly — a rejection would surface to VS Code

    // The cancellation cut the backoff immediately: resolution lands in
    // milliseconds, not after the remaining ~990 ms of sleep (an
    // uninterruptible sleep mutation lands ≥ 990 ms later).
    const cancelToResolveMs = Date.now() - cancelledAt;
    assert.ok(
      cancelToResolveMs < 500,
      `cancel must cut the backoff immediately (took ${cancelToResolveMs}ms; the remaining sleep is ~990ms)`,
    );
    assert.equal(chatFetches, 1, 'no second POST after the cancelled backoff');
    // No double-flush: onHiddenRetry already emptied the window buffer
    // when the retry was scheduled — the quiet onDone's flush must
    // deliver NOTHING from the broken attempt (neither its text delta
    // nor anything else), and no tool-call part can exist here.
    const textValues = progress.parts
      .filter((p) => p instanceof vscode.LanguageModelTextPart)
      .map((p) => (p as vscode.LanguageModelTextPart).value);
    assert.ok(
      !textValues.some((v) => v.includes('partial prefix')),
      'the broken attempt\'s buffered delta was never delivered (no double-flush on the quiet onDone)',
    );
    assert.equal(
      progress.parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart).length,
      0,
      'no tool-call part emitted',
    );
    assert.ok(
      JSON.stringify(chatBodies[0]).includes('image_url'),
      'turn 1 had sent the image RAW (the pending hash exists)',
    );

    // Turn 2 (healthy): the cancelled backoff turn's pending hash was
    // recorded FAILED at the commit site (cap=1 → capped) — the wire
    // must degrade to the never-sent marker, NOT re-upload raw pixels
    // (no accounting) and NOT the committed-duplicate marker (wrong
    // classification: commit).
    serveHealthy = true;
    await call(
      [imageMsg(IMG_A), assistantMsg('partial'), userMsg('again?')],
      new vscode.CancellationTokenSource().token,
    );
    assert.equal(chatFetches, 2, 'turn 2 dispatched');
    const turn2 = JSON.stringify(chatBodies[1]);
    assert.ok(
      !turn2.includes('image_url'),
      'cap=1: the cancelled backoff turn counted as a failed send — no raw re-upload',
    );
    assert.ok(
      turn2.includes('never successfully sent') && turn2.includes('1 attempts failed'),
      'failed-send accounting ran for the backoff-cancelled turn (commit-site classification)',
    );
  });
});
