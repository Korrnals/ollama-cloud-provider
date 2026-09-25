/**
 * Phase 0 (ADR 0010) — contract tests for `src/streamReader.ts`.
 *
 * These tests define the module's contract BEFORE the extraction (the
 * regression net exists before any old code is removed). They cover:
 *
 *   - Timer fire ordering (soft → grace → hard inactivity)
 *   - Short-timeout path (hard fire directly, no soft extension)
 *   - Connect timeout → ConnectTimeoutError → retry → success
 *   - Caller cancel mid-stream → onDone (not onError)
 *   - Socket close at 0 chunks → ZeroByteSocketCloseError
 *   - P3-2: 0-chunk closes classified outside the probe (bare
 *     AbortError / raw socket-close escaping withRetry) follow the
 *     same one-extra-visible-attempt policy as the probe path
 *   - Socket close at >0 chunks → ConnectionInterruptedError
 *   - Buffer overrun → onError with bounded message
 *   - Cancel-during-async-setup race (synchronous isCancellationRequested)
 *   - Typed errors pass through catch UNCHANGED (MidStreamError NOT
 *     reclassified via isSocketCloseError) — Security condition #4
 *   - chunksReceived incremented by shared module — condition #3
 *
 * The tests stub `global.fetch` exactly as the integration tests for
 * `ollamaClient` / `responsesClient` do (the `_loader.mjs` sets
 * `OLLAMA_HTTP_TEST_DELEGATE=1` so `httpRequest` delegates to
 * `global.fetch`).
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  readStream,
  type StreamReaderOptions,
  type StreamLineContext,
} from '../../src/streamReader.js';
import type { StreamCallbacks } from '../../src/protocolTypes.js';
import {
  MidStreamError,
  ZeroByteSocketCloseError,
  ConnectionInterruptedError,
} from '../../src/retry.js';
import { SsrfDnsError } from '../../src/ssrfGuard.js';

const BASE_URL = 'https://ollama.com/v1';
const STREAM_URL = `${BASE_URL}/test`;

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Builds a ReadableStream from an array of Uint8Array chunks.
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

/**
 * Builds a Response-like object with the given body stream and status.
 */
function mockResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status });
}

/**
 * Wires the fetch abort signal to a ReadableStream controller so aborting
 * the fetch errors the stream — mirroring real fetch behaviour where
 * `controller.abort()` causes `reader.read()` to reject with AbortError.
 */
function wireAbortSignal(
  signal: AbortSignal | null | undefined,
  controller: ReadableStreamDefaultController<Uint8Array> | null,
): void {
  if (!signal || !controller) return;
  const errorStream = (): void => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    controller.error(err);
  };
  if (signal.aborted) {
    errorStream();
  } else {
    signal.addEventListener('abort', errorStream);
  }
}

/**
 * Builds a minimal callbacks recorder.
 */
function makeCallbacks(): StreamCallbacks & {
  text: string[];
  notices: string[];
  errors: Error[];
  doneCount: number;
} {
  const text: string[] = [];
  const notices: string[] = [];
  const errors: Error[] = [];
  const state = { doneCount: 0 };
  return {
    text,
    notices,
    errors,
    get doneCount() {
      return state.doneCount;
    },
    onText: (t) => text.push(t),
    onToolCall: () => {},
    onDone: () => {
      state.doneCount += 1;
    },
    onError: (e) => errors.push(e),
    onNotice: (t) => notices.push(t),
  };
}

/**
 * Builds a minimal `StreamReaderOptions` with a `processLine` callback
 * that never terminates (returns false) and never throws. The caller
 * overrides `processLine` / `finalize` per test.
 */
function makeBaseOptions(
  overrides: Partial<StreamReaderOptions> = {},
): StreamReaderOptions {
  return {
    logTag: 'TEST',
    url: STREAM_URL,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: true }),
    processLine: (_line: string, ctx: StreamLineContext) => {
      // ArchCom 0011c: mark parsed so empty-response detection
      // doesn't fire for well-formed test streams.
      if (_line.trim()) {
        ctx.markParsed();
      }
      return false;
    },
    ...overrides,
  };
}

describe('streamReader.readStream — module contract', () => {
  beforeEach(() => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMin: 30,
      maxRetries: 0,
    });
  });

  afterEach(() => {
    const stub = global.fetch as unknown as {
      __isStub?: boolean;
      __original?: typeof fetch;
    };
    if (stub.__isStub && stub.__original) {
      global.fetch = stub.__original;
    }
  });

  // -------------------------------------------------------------------------
  // Condition #3 — chunksReceived is incremented by the shared module.
  // The callback receives NO counter; the module owns it.
  // -------------------------------------------------------------------------

  it('increments chunksReceived internally (condition #3)', async () => {
    let chunkCount = 0;
    const body = streamFromChunks([
      encode('data: hello\n'),
      encode('data: world\n'),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({
        processLine: () => {
          chunkCount += 1;
          return false;
        },
      }),
      recorder,
    );

    // Two chunks emitted → processLine called twice (once per line).
    assert.equal(chunkCount, 2, 'processLine must fire once per data line');

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // ArchCom 0011c (SSE finding #1) — captive-portal / non-SSE body
  // detection. Bytes arrive (chunksReceived > 0) but NONE parse as
  // meaningful stream events (parsedChunks stays 0). Likely an HTML
  // captive portal, CDN error page, or proxy interception served at
  // HTTP 200. The module must surface onError — NOT a silent empty
  // success (onDone).
  // -------------------------------------------------------------------------

  it('surfaces onError (not onDone) when bytes arrive but none parse as stream events (captive-portal detection)', async () => {
    // Raw HTML — as if a captive portal / proxy served an error page
    // at HTTP 200 instead of a real SSE stream.
    const htmlBody = '<html><body>error</body></html>\n';
    const body = streamFromChunks([encode(htmlBody)]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({
        // processLine that ONLY marks real SSE data lines as parsed.
        // An HTML line is not a valid stream event → markParsed is
        // NOT called → parsedChunks stays 0 → onError must fire.
        processLine: (line: string, ctx: StreamLineContext) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            ctx.markParsed();
          }
          return false;
        },
      }),
      recorder,
    );

    // Bytes arrived but none were valid SSE → onError, NOT onDone.
    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire when no chunk parses as a stream event',
    );
    assert.match(
      recorder.errors[0]!.message,
      /none were valid stream events/,
      'error message must explain the captive-portal / non-SSE cause',
    );
    assert.equal(
      recorder.doneCount,
      0,
      'onDone must NOT fire — silent empty success is forbidden',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Timer fire ordering — soft (120s) → grace (300s) → hard inactivity.
  // We use a short inactivity that is ABOVE the soft threshold to test
  // the soft path. But the default soft threshold is 120000ms — too long
  // for tests. Instead we test the SHORT-timeout path (≤ soft threshold)
  // which fires hard directly.
  // -------------------------------------------------------------------------

  // ArchCom 0011c — inactivity timer permanently disabled; re-enable only if timer is restored (see ADR 0005 / 0011c)
  it.skip('fires hard inactivity directly when timeout ≤ soft threshold (short-timeout path)', async function () {
    this.timeout(5000);

    // inactivityTimeoutMs = 1000 ≤ 120000 soft threshold → hard path.
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMin: 30,
      maxRetries: 0,
    });

    let hungController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        hungController = controller;
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      wireAbortSignal(init?.signal, hungController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire on inactivity timeout',
    );
    assert.match(recorder.errors[0]!.message, /stalled/);
    assert.equal(
      recorder.doneCount,
      0,
      'onDone must NOT fire on inactivity timeout',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Caller cancel mid-stream → onDone (not onError).
  // -------------------------------------------------------------------------
  // ADR 0012 (revised) — connect-timer retry tests removed: the connect
  // timer (and ConnectTimeoutError) were deleted. A hanging fetch now
  // waits until max-duration (60 min) or caller cancel; there is no
  // connect-phase timeout to trigger a retry.

  it('fires onDone (not onError) when caller cancels mid-stream', async function () {
    this.timeout(5000);

    const source = new vscode.CancellationTokenSource();

    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encode('data: first\n'));
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      wireAbortSignal(init?.signal, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const promise = readStream(makeBaseOptions({
      cancellationToken: source.token,
    }), recorder);

    // Cancel after the first chunk is read.
    setTimeout(() => source.cancel(), 50);

    await promise;

    assert.equal(
      recorder.doneCount,
      1,
      'onDone must fire on caller cancel',
    );
    assert.equal(
      recorder.errors.length,
      0,
      'onError must NOT fire on caller cancel',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Cancel-during-async-setup race — synchronous isCancellationRequested
  // check must catch a cancellation that arrived before readStream
  // entered its async body.
  // -------------------------------------------------------------------------

  it('detects cancellation synchronously before fetch (cancel-during-async-setup race)', async function () {
    this.timeout(5000);

    const source = new vscode.CancellationTokenSource();
    source.cancel(); // cancel BEFORE calling readStream

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      // Respect the abort signal: when already aborted, reject with
      // AbortError (mirrors real httpRequest behaviour).
      const sig = init?.signal;
      if (sig?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return mockResponse(streamFromChunks([]));
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions({
      cancellationToken: source.token,
    }), recorder);

    assert.equal(
      recorder.doneCount,
      1,
      'onDone must fire on pre-entry cancellation',
    );
    assert.equal(
      recorder.errors.length,
      0,
      'onError must NOT fire on pre-entry cancellation',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Socket close at 0 chunks → ZeroByteSocketCloseError.
  //
  // ArchCom §3.4 (0.15.x): with maxRetries=0 the connect-phase withRetry
  // exhausts on its first attempt, and readStream grants exactly ONE
  // additional VISIBLE attempt (design condition for the non-idle
  // 0-chunk close) before surfacing the terminal error — so the fetch
  // mock must return a FRESH empty stream per call (a consumed
  // ReadableStream cannot be reused).
  // -------------------------------------------------------------------------

  it('fires ZeroByteSocketCloseError when socket closes at 0 chunks', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      // Empty body — fetch resolves with 200 but no chunks.
      return mockResponse(streamFromChunks([]));
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      fetchCalls,
      2,
      'initial attempt + exactly one extra visible attempt',
    );
    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire after the extra attempt fails',
    );
    assert.ok(
      recorder.errors[0] instanceof ZeroByteSocketCloseError,
      'error must be ZeroByteSocketCloseError',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // P3-2 (2026-09-15 review) — ZeroByte path unification. The
  // one-extra-visible-attempt policy must ALSO apply to non-idle 0-chunk
  // closes classified OUTSIDE the probe. The pre-fix code surfaced these
  // via a direct `callbacks.onError(new ZeroByteSocketCloseError())`,
  // bypassing the policy that a probe-path ZeroByte gets:
  //   (a) a BARE AbortError (no abortReason tag — not caller-cancel, not
  //       max-duration; message is not socket-close framing) rejecting
  //       the probe read;
  //   (b) a RAW socket-close error ESCAPING withRetry (retries exhausted
  //       — maxRetries=0 here) before any headers arrive.
  // Both must now behave exactly like the probe-path ZeroByte: ONE extra
  // VISIBLE attempt (announced via onNotice), then terminal.
  // -------------------------------------------------------------------------

  it('applies the one-extra-visible-attempt policy to a bare AbortError 0-chunk close (P3-2)', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      // 200 + headers, then the FIRST read (the probe inside withRetry)
      // rejects with a bare AbortError: no cancellation token and no
      // max-duration fire → abortReason === null, and the message is
      // not socket-close framing, so the probe passes it through raw.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          controller.error(err);
        },
      });
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      fetchCalls,
      2,
      'bare AbortError 0-chunk close: initial attempt + exactly one extra visible attempt',
    );
    assert.equal(
      recorder.notices.length,
      1,
      'the extra attempt must be announced via onNotice (visible attempt)',
    );
    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire after the extra attempt fails',
    );
    assert.ok(
      recorder.errors[0] instanceof ZeroByteSocketCloseError,
      'error must be ZeroByteSocketCloseError',
    );

    global.fetch = originalFetch;
  });

  it('applies the one-extra-visible-attempt policy to a raw socket-close escaping withRetry (P3-2)', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      // Connect-phase raw socket-close (libuv ECONNRESET) — fetch itself
      // rejects, no headers arrive. With maxRetries=0, withRetry throws
      // the RAW error on its first attempt; readStreamOnce reclassifies
      // the 0-chunk case and the readStream policy (not a direct
      // onError) decides what follows.
      const err = new Error('read ECONNRESET');
      (err as { code?: string }).code = 'ECONNRESET';
      throw err;
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      fetchCalls,
      2,
      'raw socket-close 0-chunk: initial attempt + exactly one extra visible attempt',
    );
    assert.equal(
      recorder.notices.length,
      1,
      'the extra attempt must be announced via onNotice (visible attempt)',
    );
    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire after the extra attempt fails',
    );
    assert.ok(
      recorder.errors[0] instanceof ZeroByteSocketCloseError,
      'error must be ZeroByteSocketCloseError',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Socket close at >0 chunks → ConnectionInterruptedError.
  //
  // ArchCom §3.4 (0.15.x): the 50-chunk mid-stream retry threshold is
  // ABOLISHED. With no commit-window attached to the callbacks there is
  // no silent-retry boundary, so a mid-stream socket close is TERMINAL
  // on the first attempt (the window-attached silent retry is covered
  // by test/unit/commitWindow.test.ts).
  // -------------------------------------------------------------------------

  it('fires ConnectionInterruptedError when socket closes after chunks received', async function () {
    this.timeout(5000);
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      // Fresh stream per fetch call: one chunk, then a mid-stream
      // socket-close error after a short delay.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: partial\n'));
          setTimeout(() => {
            const e = new Error('aborted at TLSSocket.socketCloseListener');
            controller.error(e);
          }, 50);
        },
      });
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    // Terminal CIE: readStream throws ConnectionInterruptedError (no
    // retry — no window attached, threshold abolished).
    await assert.rejects(
      async () => readStream(makeBaseOptions(), recorder),
      (error: unknown) => {
        assert.ok(
          error instanceof ConnectionInterruptedError,
          'error must be ConnectionInterruptedError (chunksReceived > 0)',
        );
        return true;
      },
    );
    assert.equal(fetchCalls, 1, 'terminal on the first attempt — no retry');

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Buffer overrun → onError with bounded message.
  // -------------------------------------------------------------------------

  it('fires onError with bounded message when buffer exceeds 1 MiB', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 10);
    const body = streamFromChunks([encode(`data: ${huge}`)]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire on buffer overrun',
    );
    assert.match(
      recorder.errors[0]!.message,
      /buffer exceeded/,
      'error must mention the buffer cap',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // CRITICAL — Security condition #4: typed errors pass through catch
  // UNCHANGED. The parsing callback throws MidStreamError; the catch
  // must NOT reclassify it via isSocketCloseError.
  // -------------------------------------------------------------------------

  it('passes MidStreamError through catch UNCHANGED (condition #4)', async () => {
    const body = streamFromChunks([encode('data: trigger-error\n')]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({
        processLine: () => {
          // Simulate the parser detecting a server-sent error event.
          throw new MidStreamError('server rejected the request');
        },
      }),
      recorder,
    );

    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire when parser throws MidStreamError',
    );
    assert.ok(
      recorder.errors[0] instanceof MidStreamError,
      'error must be MidStreamError (NOT reclassified)',
    );
    assert.equal(
      recorder.errors[0]!.message,
      'server rejected the request',
      'MidStreamError message must pass through unchanged',
    );
    // CRITICAL: must NOT be reclassified to a socket-close error.
    assert.ok(
      !(recorder.errors[0] instanceof ZeroByteSocketCloseError),
      'MidStreamError must NOT be reclassified to ZeroByteSocketCloseError',
    );
    assert.ok(
      !(recorder.errors[0] instanceof ConnectionInterruptedError),
      'MidStreamError must NOT be reclassified to ConnectionInterruptedError',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Terminal line from processLine (returns true) → onDone, finalize NOT
  // called — the callback handles its own termination (e.g. [DONE] marker
  // in compat mode calls flushToolCalls + onDone internally, then returns
  // true). The module's `finalize` is ONLY for natural stream-end without
  // a terminal line.
  // -------------------------------------------------------------------------

  it('does NOT call finalize when processLine returns true (callback owns termination)', async () => {
    const body = streamFromChunks([encode('data: terminal\n')]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    let finalized = false;
    let callbackOnDone = false;
    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({
        processLine: () => {
          // The callback owns terminal termination — it calls onDone
          // itself (like compat [DONE] → flushToolCalls + onDone).
          callbackOnDone = true;
          recorder.onDone();
          return true;
        },
        finalize: (cb) => {
          finalized = true;
          cb.onDone();
        },
      }),
      recorder,
    );

    assert.equal(finalized, false, 'finalize must NOT fire when processLine returns true');
    assert.equal(callbackOnDone, true, 'callback must own terminal termination');

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Happy path — stream ends naturally (chunk.done) with chunks received,
  // no terminal line → finalize → onDone.
  // -------------------------------------------------------------------------

  it('fires finalize then onDone when stream ends naturally with chunks', async () => {
    const body = streamFromChunks([encode('data: chunk1\n')]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    let finalized = false;
    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({
        finalize: (cb) => {
          finalized = true;
          cb.onDone();
        },
      }),
      recorder,
    );

    assert.equal(finalized, true, 'finalize must fire on natural stream end');
    assert.equal(
      recorder.doneCount,
      1,
      'onDone must fire after natural stream end + finalize',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Stream ends naturally with 0 chunks and NO finalize →
  // ZeroByteSocketCloseError (not silent onDone). ArchCom §3.4: after
  // the one extra visible attempt (fresh stream per fetch call).
  // -------------------------------------------------------------------------

  it('fires ZeroByteSocketCloseError when stream ends with 0 chunks (no finalize)', async () => {
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      return mockResponse(streamFromChunks([]));
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      fetchCalls,
      2,
      'initial attempt + the single extra visible attempt',
    );
    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire on 0-chunk natural close',
    );
    assert.ok(
      recorder.errors[0] instanceof ZeroByteSocketCloseError,
      'error must be ZeroByteSocketCloseError',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // resetInactivity is exposed via the StreamLineContext — keep-alive
  // comments reset the timer.
  // -------------------------------------------------------------------------

  it('exposes resetInactivity via StreamLineContext to the processLine callback', async () => {
    let resetCalled = false;
    const body = streamFromChunks([encode(': keep-alive\n')]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({
        processLine: (_line, ctx) => {
          ctx.resetInactivity();
          resetCalled = true;
          return false;
        },
      }),
      recorder,
    );

    assert.equal(resetCalled, true, 'processLine must receive ctx with resetInactivity');

    global.fetch = originalFetch;
  });
});

/**
 * v0.20.1 — SSRF-guard DNS blip retry (RCA 2026-09-25: a transient
 * `ENOTFOUND` on ollama.com killed the turn with a terminal error).
 * `assertUrlAllowed` runs INSIDE the connect-phase `withRetry`, so a
 * typed `SsrfDnsError` carrying a retryable code must be retried by
 * `defaultRetryOn` and the request must succeed on the next attempt —
 * the same dependency-injected resolver seam the probe tests use (no
 * real DNS is touched).
 */
describe('streamReader.readStream — ssrfGuard DNS blip retry (v0.20.1)', () => {
  it('retries a SsrfDnsError(ENOTFOUND) from assertUrlAllowed and succeeds on the next attempt', async () => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMin: 30,
      maxRetries: 2,
    });

    let guardCalls = 0;
    let fetchCalls = 0;
    const body = streamFromChunks([
      encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
      encode('data: [DONE]\n'),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      return mockResponse(body);
    }) as typeof fetch;

    // The guard fails with a DNS blip on the FIRST call and resolves on
    // every later one — the classic transient resolver hiccup.
    const ssrfGuard = {
      assertUrlAllowed: async (_url: string) => {
        guardCalls += 1;
        if (guardCalls === 1) {
          throw new SsrfDnsError('ENOTFOUND', 'ollama.com');
        }
      },
    };

    const recorder = makeCallbacks();
    await readStream(
      makeBaseOptions({ ssrfGuard, connectRetryBaseDelayMs: 1 }),
      recorder,
    );

    assert.equal(guardCalls, 2, 'assertUrlAllowed ran twice (initial + retry)');
    assert.equal(fetchCalls, 1, 'fetch ran once — the DNS blip failed before connect');
    assert.equal(recorder.doneCount, 1, 'the retried attempt completed the stream');
    assert.equal(recorder.errors.length, 0, 'no error surfaced after the retry');

    global.fetch = originalFetch;
  });

  it('does NOT retry a SsrfDnsError with a non-transient code (terminal)', async () => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 120000,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMin: 30,
      maxRetries: 3,
    });

    let guardCalls = 0;
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      return mockResponse(streamFromChunks([encode('data: x\n')]));
    }) as typeof fetch;

    const ssrfGuard = {
      assertUrlAllowed: async (_url: string) => {
        guardCalls += 1;
        throw new SsrfDnsError('NXDOMAIN', 'ollama.com');
      },
    };

    const recorder = makeCallbacks();
    // Direct readStream calls surface terminal errors via
    // callbacks.onError and RESOLVE — assert on the recorder, not on a
    // rejection.
    await readStream(
      makeBaseOptions({ ssrfGuard, connectRetryBaseDelayMs: 1 }),
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'terminal error surfaced via onError');
    assert.ok(
      recorder.errors[0] instanceof SsrfDnsError &&
        (recorder.errors[0] as SsrfDnsError).code === 'NXDOMAIN',
      'the SsrfDnsError(NXDOMAIN) surfaced unchanged',
    );
    assert.equal(guardCalls, 1, 'no retry burned on a non-transient DNS code');
    assert.equal(fetchCalls, 0, 'never reached fetch');
    assert.equal(recorder.doneCount, 0, 'no completion on a terminal error');

    global.fetch = originalFetch;
  });
});
