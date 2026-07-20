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
      maxRetries: 0,
    });
  });

  afterEach(() => {
    const stub = global.fetch as any;
    if (stub.__isStub && stub.__original) global.fetch = stub.__original;
  });

  it('fires onError when the request times out', async function () {
    // The production code clamps requestTimeoutMs to a 5000ms minimum
    // (REQUEST_TIMEOUT_MIN_MS in ollamaClient.ts). We set 6000ms (above
    // the clamp floor) and give mocha 15s so the request timeout fires
    // before the test timeout. Using `function` (not arrow) so `this`
    // binds to the mocha context for `this.timeout()`.
    this.timeout(15000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestTimeoutMs: 6000,
      maxRetries: 0,
    });

    // Stub fetch to return a stream that NEVER emits (simulates a hung
    // connection). The timeout abort fires first; the wired signal errors
    // the stream so reader.read() rejects with an AbortError.
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

    assert.equal(recorder.errors.length, 1, 'onError must fire on timeout');
    assert.match(recorder.errors[0]!.message, /timed out/);
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire on timeout');

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
      /SSE buffer exceeded/,
      'error must mention the SSE buffer cap',
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