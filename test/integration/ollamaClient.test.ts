import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { OllamaClient } from '../../src/ollamaClient.js';
import type { StreamCallbacks } from '../../src/protocolTypes.js';

const BASE_URL = 'https://ollama.com/v1';

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Builds a ReadableStream from an array of Uint8Array chunks. The
 * stream emits chunks in order and closes when the array is exhausted.
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
 * Wires the fetch abort signal to a ReadableStream controller so that
 * aborting the fetch errors the stream — mirroring real fetch behaviour
 * where `controller.abort()` causes `response.body.getReader().read()`
 * to reject with an AbortError. Without this wiring, the mock stream
 * would hang forever after abort because ReadableStream is independent
 * of the fetch signal in the test environment.
 */
function wireAbortSignal(
  signal: AbortSignal | undefined,
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
 * Builds a minimal callbacks recorder. Each callback pushes to its
 * array so the test can assert ordering.
 */
function makeCallbacks(): StreamCallbacks & {
  text: string[];
  errors: Error[];
  doneCount: number;
} {
  const text: string[] = [];
  const errors: Error[] = [];
  // Use a mutable state object so the getter reflects the current count.
  // A plain `doneCount` property would snapshot 0 at creation time and
  // never update — the onDone closure would increment a local variable
  // invisible to the assertion.
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

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('ollamaClient.streamChat — timeout / buffer / cancel', () => {
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
    const stub = global.fetch as any;
    if (stub.__isStub && stub.__original) global.fetch = stub.__original;
  });

  it('fires onError when the stream stalls (inactivity timeout, no chunks)', async function () {
    // ADR 0005 — a hung connection (fetch resolves, no chunks) is
    // detected by the inactivity timer. We set inactivity to 1000ms;
    // the resolver accepts below-minimum values (package.json enforces
    // the UI floor, the resolver only guards against garbage), so the
    // test runs fast.
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
    });

    // Stub fetch to return a stream that NEVER emits (simulates a hung
    // connection after the response headers arrive). The inactivity
    // timer fires; the wired signal errors the stream so reader.read()
    // rejects with an AbortError.
    let hungController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        hungController = controller;
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      wireAbortSignal(init?.signal ?? undefined, hungController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError must fire on inactivity timeout');
    assert.match(recorder.errors[0]!.message, /stalled/);
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire on inactivity timeout');

    global.fetch = originalFetch;
  });

  it('fires onError when the SSE buffer exceeds 1 MiB without a newline', async () => {
    // Build a single chunk > 1 MiB with NO newline. The buffer cap
    // fires before any line is processed.
    const huge = 'x'.repeat(1024 * 1024 + 10);
    const body = streamFromChunks([encode(`data: ${huge}`)]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError must fire on buffer overrun');
    assert.match(
      recorder.errors[0]!.message,
      /stream buffer exceeded/,
      'error must mention the stream buffer cap',
    );

    
    global.fetch = originalFetch;
  });

  it('fires onDone when the caller cancels mid-stream', async function () {
    // Use `function` so `this` binds to the mocha context for timeout.
    // The cancel fires at 10ms, but give mocha headroom in case the
    // event loop is busy.
    this.timeout(5000);
    // Stream that emits one chunk then hangs — the caller cancels
    // after reading the first chunk.
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'),
        );
        // Do NOT close — the caller cancels mid-stream.
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      wireAbortSignal(init?.signal ?? undefined, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const cts = new vscode.CancellationTokenSource();
    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');

    // Cancel shortly after the stream starts so we exercise the
    // caller-cancel → onDone path (not the timeout path).
    setTimeout(() => cts.cancel(), 10);

    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
      cts.token,
    );

    assert.equal(recorder.errors.length, 0, 'onError must NOT fire on caller cancel');
    assert.equal(recorder.doneCount, 1, 'onDone must fire exactly once on cancel');
    assert.ok(recorder.text.join('').includes('hi'), 'text emitted before cancel must arrive');

    global.fetch = originalFetch;
    // Do NOT close the stream controller here — wireAbortSignal already
    // errored it when the cancel propagated, and closing an errored
    // controller throws ERR_INVALID_STATE. The stream is terminated.
  });

  it('aborts synchronously when token is already cancelled before streamChat entry', async () => {
    // Pin the v0.5.0 race fix: a cancel that arrives during async
    // setup (before streamChat registers its onCancellationRequested
    // listener) must still abort the fetch. `onCancellationRequested`
    // does NOT fire retroactively for an already-cancelled token, so
    // the synchronous `isCancellationRequested` check at entry is the
    // only thing that wires the abort before fetch runs.
    const cts = new vscode.CancellationTokenSource();
    cts.cancel(); // cancel BEFORE calling streamChat

    let abortObserved = false;
    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) abortObserved = true;
      // Real fetch rejects on an aborted signal — mimic that so the
      // client's reader loop sees the AbortError and finalises.
      throw new DOMException('The user aborted a request.', 'AbortError');
    }) as typeof fetch;

    try {
      const recorder = makeCallbacks();
      const client = new OllamaClient(BASE_URL, 'sk-test-key');
      await client.streamChat(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        recorder,
        cts.token,
      );

      assert.equal(abortObserved, true, 'fetch signal.aborted must be true for pre-entry cancel');
      assert.equal(recorder.doneCount, 1, 'onDone must fire exactly once');
      assert.equal(recorder.errors.length, 0, 'onError must not fire for user-cancel');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('processes a well-formed SSE stream end-to-end and fires onDone', async () => {
    const chunks = [
      encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n'),
      encode('data: {"choices":[{"delta":{"content":" world"}}]}\n'),
      encode('data: [DONE]\n'),
    ];
    const body = streamFromChunks(chunks);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.text.join(''), 'hello world');
    assert.equal(recorder.doneCount, 1, 'onDone must fire exactly once');
    assert.equal(recorder.errors.length, 0, 'no errors on a clean stream');

    
    global.fetch = originalFetch;
  });
});

/**
 * ADR 0005 — streaming timeout architecture tests.
 *
 * Three timers replace the single end-to-end setTimeout:
 *   connect      — wraps fetch only, retryable, 30s default
 *   inactivity   — resets per chunk + per :keep-alive, NO retry, 90s
 *   maxDuration  — never reset, NO retry, 30 min safety cap
 *
 * Tests use small timer values (1000ms / 500ms) which the resolver
 * accepts — package.json enforces the UI minimum, the resolver only
 * guards against garbage (NaN, 0, negative). This keeps the suite
 * fast without changing production behaviour.
 */
describe('ollamaClient.streamChat — ADR 0005 streaming timers', () => {
  beforeEach(() => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
    });
  });

  afterEach(() => {
    const stub = global.fetch as any;
    if (stub.__isStub && stub.__original) global.fetch = stub.__original;
  });

  it('connect timeout fires when fetch never resolves and retries', async function () {
    // fetch hangs forever — the connect timer (1000ms) aborts it.
    // maxRetries=2 → fetch called 3 times (1 + 2 retries). Each
    // attempt hits the connect timeout → ConnectTimeoutError → retried
    // via defaultRetryOn → after maxRetries exhausted → onError.
    this.timeout(15000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 1000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 2,
    });

    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      fetchCalls += 1;
      // Never resolve — simulate an unreachable server. The connect
      // timer aborts the signal; fetch rejects with AbortError.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError must fire after retries exhausted');
    assert.match(recorder.errors[0]!.message, /connect timeout/);
    assert.equal(fetchCalls, 3, 'fetch must be called maxRetries+1 = 3 times');
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire');

    global.fetch = originalFetch;
  });

  it('inactivity timer resets on each chunk — long stream does not false-trigger', async function () {
    // Chunks every 50ms for 300ms; inactivity=1000ms. Each chunk
    // resets the timer → onDone (not onError).
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let count = 0;
        const interval = setInterval(() => {
          if (count < 5) {
            controller.enqueue(
              encode('data: {"choices":[{"delta":{"content":"x"}}]}\n'),
            );
            count += 1;
          } else {
            controller.enqueue(encode('data: [DONE]\n'));
            controller.close();
            clearInterval(interval);
          }
        }, 50);
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 0, 'no errors — timer keeps resetting');
    assert.equal(recorder.doneCount, 1, 'onDone fires after stream completes');
    assert.equal(recorder.text.join(''), 'xxxxx');

    global.fetch = originalFetch;
  });

  it('mid-stream stall (chunk, then long gap) aborts without retry', async function () {
    // Emit 1 chunk, then 90s gap (inactivity=1000ms test). Assert
    // onError with "stalled" and NO retry (fetch called once).
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMs: 1800000,
      maxRetries: 2,
    });

    let fetchCalls = 0;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'),
        );
        // Do NOT close — stall after the first chunk.
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      fetchCalls += 1;
      wireAbortSignal(init?.signal ?? undefined, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError must fire on stall');
    assert.match(recorder.errors[0]!.message, /stalled/);
    assert.equal(fetchCalls, 1, 'NO retry — fetch called once (mid-stream terminal)');
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire on stall');

    global.fetch = originalFetch;
  });

  it('first-token timeout (fetch resolves, 0 chunks) → onError', async function () {
    // fetch resolves, stream never emits, inactivity=500ms fires.
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 500,
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
      wireAbortSignal(init?.signal ?? undefined, hungController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError fires on first-token timeout');
    assert.match(recorder.errors[0]!.message, /stalled/);
    assert.equal(recorder.doneCount, 0);

    global.fetch = originalFetch;
  });

  it('max stream duration fires after N ms of continuous chunks', async function () {
    // Chunks every 50ms; maxDuration=300ms. The max-duration timer
    // fires even though chunks keep coming (it never resets).
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 300,
      maxRetries: 0,
    });

    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        const interval = setInterval(() => {
          controller.enqueue(
            encode('data: {"choices":[{"delta":{"content":"x"}}]}\n'),
          );
        }, 50);
        // Clean up after the test aborts the stream.
        (controller as any)._testInterval = interval;
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      wireAbortSignal(init?.signal ?? undefined, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError fires on max duration');
    assert.match(recorder.errors[0]!.message, /max stream duration/);
    assert.equal(recorder.doneCount, 0);

    if ((streamController as any)?._testInterval) {
      clearInterval((streamController as any)._testInterval);
    }
    global.fetch = originalFetch;
  });

  it('CancellationToken still aborts immediately and routes to onDone', async function () {
    // Existing cancel semantics must hold with the new timers.
    this.timeout(5000);

    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'),
        );
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      wireAbortSignal(init?.signal ?? undefined, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const cts = new vscode.CancellationTokenSource();
    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');

    setTimeout(() => cts.cancel(), 10);

    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
      cts.token,
    );

    assert.equal(recorder.errors.length, 0, 'cancel routes to onDone, not onError');
    assert.equal(recorder.doneCount, 1, 'onDone fires on cancel');
    assert.ok(recorder.text.join('').includes('hi'));

    global.fetch = originalFetch;
  });

  it('long-thinking model (chunks every 500ms for 3s) does not false-trigger inactivity', async function () {
    // inactivity=1000ms, chunks every 500ms — each chunk resets the
    // timer before it fires. Stream completes normally.
    this.timeout(10000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let count = 0;
        const interval = setInterval(() => {
          if (count < 6) {
            controller.enqueue(
              encode('data: {"choices":[{"delta":{"reasoning":"..."}}]}\n'),
            );
            count += 1;
          } else {
            controller.enqueue(encode('data: [DONE]\n'));
            controller.close();
            clearInterval(interval);
          }
        }, 500);
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 0, 'no false inactivity trigger');
    assert.equal(recorder.doneCount, 1, 'onDone fires normally');

    global.fetch = originalFetch;
  });

  it('requestTimeoutMs (legacy) maps to requestMaxDurationMs — bounds total duration', async function () {
    // Set ONLY requestTimeoutMs=400 (legacy), leave the new settings
    // unset. The resolver maps legacy → maxDuration=400. A stream that
    // emits chunks forever hits max-duration at 400ms.
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 400,
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      // requestMaxDurationMs intentionally unset → alias kicks in
      maxRetries: 0,
    });

    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        const interval = setInterval(() => {
          controller.enqueue(
            encode('data: {"choices":[{"delta":{"content":"x"}}]}\n'),
          );
        }, 50);
        (controller as any)._testInterval = interval;
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      wireAbortSignal(init?.signal ?? undefined, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'legacy timeout bounds total duration');
    assert.match(
      recorder.errors[0]!.message,
      /max stream duration/,
      'legacy requestTimeoutMs maps to maxDuration error',
    );

    if ((streamController as any)?._testInterval) {
      clearInterval((streamController as any)._testInterval);
    }
    global.fetch = originalFetch;
  });

  it('connect timeout retries with a fresh AbortController and succeeds on the 3rd attempt', async function () {
    // Regression test for the per-attempt AbortController fix
    // (ADR 0005). Before the fix, the connect timer aborted the MAIN
    // controller. Once aborted, `fetch(url, { signal: aborted })`
    // rejected instantly on every retry — all attempts wasted, user
    // saw "connect timeout after 30000ms". With the fix, each attempt
    // gets its own fresh `attemptController`; only the connect timer
    // aborts it (per-attempt), so retry actually re-issues fetch.
    //
    // Mock fetch to hang (never resolve) for the first 2 attempts,
    // then resolve a clean SSE stream on the 3rd. connectTimeoutMs
    // is short (100ms) so each hang triggers a ConnectTimeoutError
    // quickly. maxRetries=3 → fetch called 3 times (2 timeouts + 1
    // success). This test would FAIL with the old bug: after the
    // first connect timeout aborted the main controller, attempts 2
    // and 3 would reject instantly with AbortError — fetch would be
    // called 3 times but the 3rd would never reach the success
    // branch because its signal is already aborted, so onDone would
    // never fire and onError would fire instead.
    this.timeout(15000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 100,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 3,
    });

    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      fetchCalls += 1;
      const signal = init?.signal;
      // Attempts 1 and 2: hang until the connect timer aborts the
      // per-attempt signal. Attempt 3: resolve a clean stream.
      if (fetchCalls < 3) {
        return new Promise<Response>((_resolve, reject) => {
          if (signal) {
            if (signal.aborted) {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
              return;
            }
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      // Attempt 3 — success. Return a minimal well-formed SSE stream.
      const body = streamFromChunks([
        encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
        encode('data: [DONE]\n'),
      ]);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(fetchCalls, 3, 'fetch must be called 3 times (2 connect timeouts + 1 success)');
    assert.equal(recorder.doneCount, 1, 'onDone must fire after the 3rd attempt succeeds');
    assert.equal(recorder.errors.length, 0, 'onError must NOT fire — retry recovered');
    assert.equal(recorder.text.join(''), 'ok', 'stream text from the 3rd attempt is delivered');

    global.fetch = originalFetch;
  });
});

/**
 * ADR 0008 Phase 2 level-4 — raw Node socket-close errors (the
 * `aborted at TLSSocket.socketCloseListener` stack trace the user saw
 * in production) must be classified by the streaming client, not
 * surfaced verbatim. These tests reproduce the failure mode: fetch
 * resolves 200 + headers, then the underlying TLS socket closes
 * before/after the first body byte, emitting a plain Node `Error`
 * (name='Error', message='aborted') through the response stream.
 *
 * Reproduction strategy: the mock fetch returns a ReadableStream whose
 * controller ERRORS with the raw socket-close Error (not an
 * AbortError). The streaming client's `reader.read()` rejects with
 * this raw Error, which must be reclassified before reaching
 * `onError`.
 */
describe('ollamaClient.streamChat — ADR 0008 socket-close classification', () => {
  beforeEach(() => {
    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
    });
  });

  afterEach(() => {
    const stub = global.fetch as any;
    if (stub.__isStub && stub.__original) global.fetch = stub.__original;
  });

  it('classifies a 0-byte socket close (before any chunk) as ZeroByteSocketCloseError', async function () {
    // Reproduces the production symptom: fetch resolves 200 + headers,
    // then the TLS socket closes before any body byte. The raw Error
    // (`aborted`) reaches reader.read() and must be reclassified to
    // ZeroByteSocketCloseError — NOT surfaced as a raw stack trace.
    this.timeout(5000);

    const originalFetch = global.fetch;
    global.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // Emit zero chunks, then error the stream with the raw Node
          // socket-close Error — exactly what TLSSocket.socketCloseListener
          // surfaces in production.
          const socketErr = new Error('aborted');
          // NOTE: name stays 'Error' (NOT 'AbortError') — this is the
          // gap. A real AbortError would route through the abort branch;
          // a plain 'aborted' Error escapes every AbortError check.
          controller.error(socketErr);
        },
      });
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError must fire once');
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire');
    assert.match(
      recorder.errors[0]!.message,
      /stream closed before any chunk arrived/,
      'must be reclassified as ZeroByteSocketCloseError, not a raw stack trace',
    );
    assert.equal(
      recorder.errors[0]!.constructor.name,
      'ZeroByteSocketCloseError',
    );

    global.fetch = originalFetch;
  });

  it('classifies a mid-stream socket close (after chunks) as ConnectionInterruptedError', async function () {
    // Reproduces: stream emits some chunks, then the TLS socket closes.
    // The raw Error must be reclassified to ConnectionInterruptedError
    // (terminal, tokens already billed) — NOT a raw stack trace.
    //
    // The mock enqueues two chunks, then errors the stream on the next
    // microtask. The reader's read() loop consumes the two chunks
    // (incrementing chunksReceived to 2), then the third read() rejects
    // with the raw socket-close Error. The outer catch sees
    // chunksReceived=2 > 0 → ConnectionInterruptedError.
    this.timeout(5000);

    const originalFetch = global.fetch;
    global.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // Emit two chunks immediately (enqueue places them in the
          // stream's internal queue; the reader drains them via read()).
          controller.enqueue(
            encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n'),
          );
          controller.enqueue(
            encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n'),
          );
          // Defer the socket-close error so the reader has a chance to
          // consume the enqueued chunks first. Without the deferral the
          // stream's errored-state transition may discard the queued
          // chunks before read() sees them (implementation-dependent),
          // which would make chunksReceived stay 0.
          setTimeout(() => {
            // Raw Node socket-close Error — no [DONE], no clean close.
            const socketErr = new Error(
              'aborted at TLSSocket.socketCloseListener (node:_http_client:553:19)',
            );
            controller.error(socketErr);
          }, 20);
        },
      });
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1, 'onError must fire once');
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire');
    assert.equal(
      recorder.errors[0]!.constructor.name,
      'ConnectionInterruptedError',
      'mid-stream socket close must be ConnectionInterruptedError, not raw',
    );
    assert.match(
      recorder.errors[0]!.message,
      /connection interrupted after \d+ chunk/,
    );
    // The user-facing message must NOT contain the raw Node stack trace.
    assert.doesNotMatch(
      recorder.errors[0]!.message,
      /socketCloseListener|node:_http_client/,
      'message must be clean, not the raw stack trace',
    );
    // The partial text was delivered before the socket closed.
    assert.equal(recorder.text.join(''), 'hello');

    global.fetch = originalFetch;
  });

  it('retries a connect-phase socket close when maxRetries > 0', async function () {
    // Connect-phase socket close: the TLS socket closes BEFORE the
    // response arrives, so `httpRequest` rejects inside `withRetry`.
    // `defaultRetryOn` must treat the raw socket-close as retryable
    // (mirrors ZeroByteSocketCloseError, ADR 0008 Phase 3) so a
    // transient TLS reset recovers instead of surfacing to the user.
    this.timeout(10000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 90000,
      requestMaxDurationMs: 1800000,
      maxRetries: 2,
    });

    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls < 3) {
        // Attempts 1, 2: socket closes before the response — fetch
        // REJECTS with a raw socket-close Error (name='Error', NOT
        // AbortError). This is the connect-phase path `withRetry` sees.
        throw new Error('aborted');
      }
      // Attempt 3: clean stream.
      const body = streamFromChunks([
        encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
        encode('data: [DONE]\n'),
      ]);
      return mockResponse(body);
    }) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new OllamaClient(BASE_URL, 'sk-test-key');
    await client.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      recorder,
    );

    assert.equal(fetchCalls, 3, 'fetch must retry on connect-phase socket close');
    assert.equal(recorder.doneCount, 1, 'onDone must fire after retry recovers');
    assert.equal(recorder.errors.length, 0, 'onError must NOT fire');
    assert.equal(recorder.text.join(''), 'ok');

    global.fetch = originalFetch;
  });
});
