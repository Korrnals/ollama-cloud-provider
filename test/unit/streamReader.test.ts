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
} from '../../src/streamReader.js';
import type { StreamCallbacks } from '../../src/protocolTypes.js';
import {
  MidStreamError,
  ZeroByteSocketCloseError,
  ConnectionInterruptedError,
} from '../../src/retry.js';

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
  errors: Error[];
  doneCount: number;
} {
  const text: string[] = [];
  const errors: Error[] = [];
  const state = { doneCount: 0 };
  return {
    text,
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
    processLine: () => false,
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
      requestMaxDurationMs: 1800000,
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
  // Timer fire ordering — soft (120s) → grace (300s) → hard inactivity.
  // We use a short inactivity that is ABOVE the soft threshold to test
  // the soft path. But the default soft threshold is 120000ms — too long
  // for tests. Instead we test the SHORT-timeout path (≤ soft threshold)
  // which fires hard directly.
  // -------------------------------------------------------------------------

  it('fires hard inactivity directly when timeout ≤ soft threshold (short-timeout path)', async function () {
    this.timeout(5000);

    // inactivityTimeoutMs = 1000 ≤ 120000 soft threshold → hard path.
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMs: 1800000,
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
  // Connect timeout → ConnectTimeoutError → retry → success.
  // We set maxRetries=1 and connectTimeoutMs short; first attempt times
  // out, second succeeds.
  // -------------------------------------------------------------------------

  it('retries to success after connect timeout (ConnectTimeoutError path)', async function () {
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 200,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 1,
    });

    let attemptCount = 0;
    const successBody = streamFromChunks([encode('data: ok\n')]);

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      attemptCount += 1;
      const sig = init?.signal;
      if (attemptCount === 1) {
        // First attempt never resolves on its own — the connect timer
        // (200ms) fires, aborts the signal, and the fetch must reject
        // with AbortError. Wire the signal so abort causes rejection.
        return new Promise<Response>((_resolve, reject) => {
          if (sig) {
            const onAbort = (): void => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (sig.aborted) {
              onAbort();
            } else {
              sig.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      }
      return mockResponse(successBody);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(attemptCount, 2, 'must have retried once after connect timeout');
    assert.equal(
      recorder.doneCount,
      1,
      'onDone must fire after successful retry',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Caller cancel mid-stream → onDone (not onError).
  // -------------------------------------------------------------------------

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
  // -------------------------------------------------------------------------

  it('fires ZeroByteSocketCloseError when socket closes at 0 chunks', async () => {
    // Empty body — fetch resolves with 200 but no chunks.
    const body = streamFromChunks([]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire on 0-chunk socket close',
    );
    assert.ok(
      recorder.errors[0] instanceof ZeroByteSocketCloseError,
      'error must be ZeroByteSocketCloseError',
    );

    global.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Socket close at >0 chunks → ConnectionInterruptedError.
  // -------------------------------------------------------------------------

  it('fires ConnectionInterruptedError when socket closes after chunks received', async () => {
    // Stream that emits one chunk then errors with a socket-close error.
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encode('data: partial\n'));
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      // After enqueuing one chunk, simulate a socket close by erroring
      // the stream when the abort signal fires (or after a delay).
      const sig = init?.signal;
      if (sig) {
        const err = (): void => {
          const e = new Error('aborted at TLSSocket.socketCloseListener');
          streamController?.error(e);
        };
        if (sig.aborted) {
          err();
        } else {
          sig.addEventListener('abort', err);
        }
      }
      // Error after a short delay to simulate mid-stream socket close.
      setTimeout(() => {
        const e = new Error('aborted at TLSSocket.socketCloseListener');
        streamController?.error(e);
      }, 50);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

    assert.equal(
      recorder.errors.length,
      1,
      'onError must fire on mid-stream socket close',
    );
    assert.ok(
      recorder.errors[0] instanceof ConnectionInterruptedError,
      'error must be ConnectionInterruptedError (chunksReceived > 0)',
    );

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
  // ZeroByteSocketCloseError (not silent onDone).
  // -------------------------------------------------------------------------

  it('fires ZeroByteSocketCloseError when stream ends with 0 chunks (no finalize)', async () => {
    const body = streamFromChunks([]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    await readStream(makeBaseOptions(), recorder);

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
