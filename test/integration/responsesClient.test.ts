import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ResponsesClient } from '../../src/responsesClient.js';
import type { StreamCallbacks } from '../../src/protocolTypes.js';

const BASE_URL = 'https://ollama.com/v1';

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
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

function mockResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status });
}

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

function makeCallbacks(): StreamCallbacks & {
  text: string[];
  thinking: string[];
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  errors: Error[];
  doneCount: number;
} {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const errors: Error[] = [];
  const state = { doneCount: 0 };
  return {
    text,
    thinking,
    toolCalls,
    errors,
    get doneCount() {
      return state.doneCount;
    },
    onText: (t) => text.push(t),
    onToolCall: (tc) => toolCalls.push(tc),
    onThinking: (t) => thinking.push(t),
    onDone: () => {
      state.doneCount += 1;
    },
    onError: (e) => errors.push(e),
  };
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Builds an SSE event pair: `event: <type>\ndata: <json>\n\n`.
function event(type: string, json: string): Uint8Array {
  return encode(`event: ${type}\ndata: ${json}\n\n`);
}

describe('responsesClient.streamResponses — /v1/responses event protocol', () => {
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

  it('parses a full stream into onThinking + onText + onDone', async () => {
    const chunks = [
      event('response.created', '{"response":{"id":"r1","status":"in_progress"}}'),
      event(
        'response.reasoning_summary_text.delta',
        '{"delta":"thinking...","item_id":"rs1"}',
      ),
      event('response.output_text.delta', '{"delta":"answer","item_id":"m1"}'),
      event(
        'response.completed',
        '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
      ),
    ];
    const body = streamFromChunks(chunks);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.thinking.join(''), 'thinking...');
    assert.equal(recorder.text.join(''), 'answer');
    assert.equal(recorder.doneCount, 1, 'onDone must fire exactly once');
    assert.equal(recorder.errors.length, 0, 'no errors on a clean stream');

    global.fetch = originalFetch;
  });

  it('fires onUsage with token counts on response.completed', async () => {
    let usageObserved: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    const recorder = makeCallbacks();
    recorder.onUsage = (u) => {
      usageObserved = u;
    };
    const body = streamFromChunks([
      event(
        'response.completed',
        '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}}}',
      ),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.deepEqual(usageObserved, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
    assert.equal(recorder.doneCount, 1);

    global.fetch = originalFetch;
  });

  it('parses a function_call output_item.done into onToolCall', async () => {
    const body = streamFromChunks([
      event(
        'response.output_item.done',
        '{"item":{"id":"fc1","type":"function_call","call_id":"call-9","name":"search","arguments":"{\\"q\\":\\"x\\"}"},"output_index":0}',
      ),
      event(
        'response.completed',
        '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.toolCalls.length, 1);
    assert.equal(recorder.toolCalls[0].id, 'call-9');
    assert.equal(recorder.toolCalls[0].name, 'search');
    assert.deepEqual(recorder.toolCalls[0].input, { q: 'x' });

    global.fetch = originalFetch;
  });

  it('fires onError on response.failed', async () => {
    const body = streamFromChunks([
      event(
        'response.failed',
        '{"response":{"id":"r1","status":"failed","error":{"message":"model overloaded","type":"server_error"}}}',
      ),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1);
    assert.match(recorder.errors[0].message, /model overloaded/);
    assert.equal(recorder.doneCount, 0, 'onDone must NOT fire on response.failed');

    global.fetch = originalFetch;
  });

  it('fires onError on response.incomplete', async () => {
    const body = streamFromChunks([
      event(
        'response.incomplete',
        '{"response":{"id":"r1","status":"incomplete","error":{"message":"max_output_tokens reached","type":"incomplete"}}}',
      ),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1);
    assert.match(recorder.errors[0].message, /max_output_tokens/);

    global.fetch = originalFetch;
  });

  it('fires onError when the stream stalls (inactivity timeout, no events)', async function () {
    this.timeout(5000);

    setConfig({
      baseUrl: BASE_URL,
      allowedBaseUrls: [BASE_URL],
      requestConnectTimeoutMs: 30000,
      requestInactivityTimeoutMs: 1000,
      requestMaxDurationMs: 1800000,
      maxRetries: 0,
    });

    let hungController: ReadableStreamDefaultController<Uint8Array> | null = null;
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
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1);
    assert.match(recorder.errors[0].message, /stalled/);
    assert.equal(recorder.doneCount, 0);

    global.fetch = originalFetch;
  });

  it('retries the connect phase when fetch hangs (connect timeout)', async function () {
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
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.errors.length, 1);
    assert.match(recorder.errors[0].message, /connect timeout/);
    assert.equal(fetchCalls, 3, 'fetch must be called maxRetries+1 = 3 times');
    assert.equal(recorder.doneCount, 0);

    global.fetch = originalFetch;
  });

  it('fires onDone when the caller cancels mid-stream', async function () {
    this.timeout(5000);

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(event('response.output_text.delta', '{"delta":"hi","item_id":"m1"}'));
      },
    });

    const originalFetch = global.fetch;
    global.fetch = (async (_input: unknown, init?: RequestInit) => {
      wireAbortSignal(init?.signal ?? undefined, streamController);
      return mockResponse(body);
    }) as typeof fetch;

    const cts = new vscode.CancellationTokenSource();
    const recorder = makeCallbacks();
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');

    setTimeout(() => cts.cancel(), 10);

    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
      cts.token,
    );

    assert.equal(recorder.errors.length, 0, 'onError must NOT fire on caller cancel');
    assert.equal(recorder.doneCount, 1, 'onDone must fire exactly once on cancel');
    assert.ok(recorder.text.join('').includes('hi'));

    global.fetch = originalFetch;
  });

  it('treats a : keep-alive comment as inactivity reset, not data', async () => {
    // A keep-alive line followed by a normal completion. The parser
    // must NOT try to JSON-parse the keep-alive.
    const body = streamFromChunks([
      encode(': keep-alive\n\n'),
      event('response.output_text.delta', '{"delta":"ok","item_id":"m1"}'),
      event(
        'response.completed',
        '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ),
    ]);

    const originalFetch = global.fetch;
    global.fetch = (async () => mockResponse(body)) as typeof fetch;

    const recorder = makeCallbacks();
    const client = new ResponsesClient(BASE_URL, 'sk-test-key');
    await client.streamResponses(
      { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      recorder,
    );

    assert.equal(recorder.text.join(''), 'ok');
    assert.equal(recorder.doneCount, 1);
    assert.equal(recorder.errors.length, 0);

    global.fetch = originalFetch;
  });
});