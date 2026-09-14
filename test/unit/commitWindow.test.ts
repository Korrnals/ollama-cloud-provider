/**
 * ArchCom 2026-09-14 §3.4 (commit-window, 0.15.x) — tests for the
 * silent in-window retry boundary that replaces the abolished 50-chunk
 * `MID_STREAM_RETRY_MAX_CHUNKS` threshold.
 *
 * Module-level (src/commitWindow.ts):
 *   - deltas buffered until the window closes, then replayed IN ORDER;
 *   - direct streaming after the flush;
 *   - onDone/onError flush a still-open window (billed tokens are
 *     never silently discarded);
 *   - onNotice/onUsage pass through immediately;
 *   - onHiddenRetry resets the buffer and re-arms the window;
 *   - the controller is discoverable via the symbol (readStream
 *     discovery contract).
 *
 * Integration (readStream + window, ТЗ cases):
 *   (а) break INSIDE the window → silent retry: the user sees only the
 *       final text — no duplicate prefix, no flicker, no onNotice;
 *   (б) break AFTER the window → terminal ConnectionInterruptedError
 *       without any retry;
 *   (в) hidden retries are disclosed in diagnostics (logger.warn line
 *       + controller counter feeding the runStream report field);
 *   plus: zero-byte close after connect-phase retries → exactly ONE
 *       additional VISIBLE attempt (onNotice), then terminal.
 *
 * Timings: the window is constructed with tens of milliseconds (the
 * test seam `windowMs` parameter); only the hidden-retry backoff
 * (~1 s ± jitter) is real time.
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  COMMIT_WINDOW_CONTROLLER,
  COMMIT_WINDOW_DEFAULT_MS,
  createCommitWindow,
  type CommitWindowedCallbacks,
} from '../../src/commitWindow.js';
import { readStream } from '../../src/streamReader.js';
import type { StreamCallbacks, ToolCallEvent } from '../../src/protocolTypes.js';
import { logger } from '../../src/logger.js';
import { ConnectionInterruptedError, ZeroByteSocketCloseError } from '../../src/retry.js';

const ORIGINAL_FETCH = globalThis.fetch;

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function socketCloseError(): Error {
  const err = new Error('read ECONNRESET');
  (err as { code?: string }).code = 'ECONNRESET';
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface Recorded {
  events: string[];
  done: boolean;
  error: Error | undefined;
  notices: string[];
}

function recordCallbacks(): { recorded: Recorded; callbacks: StreamCallbacks } {
  const recorded: Recorded = { events: [], done: false, error: undefined, notices: [] };
  const callbacks: StreamCallbacks = {
    onText: (t) => recorded.events.push(`text:${t}`),
    onThinking: (t) => recorded.events.push(`thinking:${t}`),
    onToolCall: (tc: ToolCallEvent) => recorded.events.push(`tool:${tc.name}`),
    onDone: () => {
      recorded.done = true;
    },
    onError: (e) => {
      recorded.error = e;
    },
    onNotice: (n) => recorded.notices.push(n),
  };
  return { recorded, callbacks };
}

describe('commitWindow module (ArchCom §3.4)', () => {
  it('default window is 5000ms', () => {
    assert.strictEqual(COMMIT_WINDOW_DEFAULT_MS, 5000);
  });

  it('buffers text/thinking/toolCall until the window closes, then replays in order', async () => {
    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(40);
    const wrapped = win.wrap(callbacks);

    assert.strictEqual(win.controller.isOpen(), true, 'window open before any delta');

    wrapped.onText('a');
    wrapped.onThinking?.('b');
    wrapped.onToolCall({ id: '1', name: 'lookup', input: {} });
    assert.deepStrictEqual(recorded.events, [], 'nothing flushed while the window is open');

    await sleep(80); // window (40ms) expires
    assert.deepStrictEqual(
      recorded.events,
      ['text:a', 'thinking:b', 'tool:lookup'],
      'buffered deltas replay in original order',
    );
    assert.strictEqual(win.controller.isOpen(), false, 'window closed after flush');

    // After the flush everything streams directly.
    wrapped.onText('c');
    assert.deepStrictEqual(
      [...recorded.events].slice(-1),
      ['text:c'],
      'post-flush delta passes through immediately',
    );
  });

  it('onDone flushes a still-open window exactly once', async () => {
    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(10_000); // never fires during the test
    const wrapped = win.wrap(callbacks);

    wrapped.onText('short');
    wrapped.onDone();

    assert.deepStrictEqual(recorded.events, ['text:short']);
    assert.strictEqual(recorded.done, true, 'onDone delivered after the flush');
  });

  it('onError flushes a still-open window (billed tokens are not discarded)', async () => {
    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(10_000);
    const wrapped = win.wrap(callbacks);

    wrapped.onText('partial');
    const boom = new Error('terminal');
    wrapped.onError(boom);

    assert.deepStrictEqual(recorded.events, ['text:partial']);
    assert.strictEqual(recorded.error, boom);
  });

  it('onNotice and onUsage pass through immediately (never buffered)', async () => {
    const { recorded, callbacks } = recordCallbacks();
    let usageSeen = false;
    const base: StreamCallbacks = {
      ...callbacks,
      onUsage: () => {
        usageSeen = true;
      },
    };
    const win = createCommitWindow(10_000);
    const wrapped = win.wrap(base);

    wrapped.onText('buffered');
    wrapped.onNotice?.('visible now');
    wrapped.onUsage?.({ totalTokens: 1 });

    assert.deepStrictEqual(recorded.notices, ['visible now']);
    assert.strictEqual(usageSeen, true, 'onUsage delivered immediately');
    assert.deepStrictEqual(recorded.events, [], 'delta still buffered');
  });

  it('onHiddenRetry resets the buffer and re-arms the window', async () => {
    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(40);
    const wrapped = win.wrap(callbacks);

    wrapped.onText('dead attempt');
    win.controller.onHiddenRetry();
    assert.strictEqual(win.controller.hiddenRetryCount(), 1);
    assert.strictEqual(win.controller.isOpen(), true, 'window re-armed after reset');

    await sleep(80); // old timer must NOT fire with the discarded buffer
    assert.deepStrictEqual(recorded.events, [], 'discarded deltas never reach the user');

    wrapped.onText('live');
    wrapped.onDone();
    assert.deepStrictEqual(recorded.events, ['text:live']);
  });

  it('attaches the controller under the discovery symbol (readStream contract)', () => {
    const { callbacks } = recordCallbacks();
    const win = createCommitWindow(40);
    const wrapped = win.wrap(callbacks);
    assert.strictEqual(
      (wrapped as CommitWindowedCallbacks)[COMMIT_WINDOW_CONTROLLER],
      win.controller,
    );
  });
});

describe('commitWindow + readStream integration (ArchCom §3.4)', () => {
  beforeEach(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      requestMaxDurationMin: 60,
      maxRetries: 0,
    });
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  /**
   * Builds a processLine that parses `data: {"delta":"..."}` lines into
   * onText and terminates the stream on `data: [DONE]` (calls onDone,
   * returns true) — the module contract puts the terminal condition in
   * the callback.
   */
  function sseProcessLine(callbacks: StreamCallbacks): (line: string, ctx: { markParsed(): void }) => boolean {
    return (line, ctx) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        return false;
      }
      ctx.markParsed();
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        callbacks.onDone();
        return true;
      }
      try {
        const parsed = JSON.parse(payload) as { delta?: string };
        if (parsed.delta) {
          callbacks.onText(parsed.delta);
        }
      } catch {
        // ignore non-JSON
      }
      return false;
    };
  }

  it('(а) break inside the window → silent retry, user sees only the final text', async function () {
    this.timeout(10000); // one hidden-retry backoff (~1s ± 25% jitter)
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        // Attempt 1: one delta arrives (buffered, NOT shown), then a raw
        // socket close 20ms in — inside the 60ms window.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode('data: {"delta":"partial"}\n\n'));
            setTimeout(() => controller.error(socketCloseError()), 20);
          },
        });
        return new Response(body, { status: 200 });
      }
      // Attempt 2: complete stream.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: {"delta":"full answer"}\n\n'));
          controller.enqueue(encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(60);
    const wrapped = win.wrap(callbacks);

    await readStream(
      {
        logTag: 'cw-test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        processLine: sseProcessLine(wrapped),
      },
      wrapped,
    );

    assert.equal(fetchCalls, 2, 'exactly one hidden retry');
    assert.equal(recorded.done, true, 'second attempt completed the stream');
    assert.deepStrictEqual(
      recorded.events,
      ['text:full answer'],
      'user sees ONLY the final text — no duplicate prefix',
    );
    assert.equal(recorded.notices.length, 0, 'silent retry issues NO visible notice');
    assert.equal(recorded.error, undefined, 'no error surfaces');
    assert.equal(win.controller.hiddenRetryCount(), 1, 'hidden retry counted');
  });

  it('(б) break after the window → terminal ConnectionInterruptedError, no retry', async function () {
    this.timeout(10000);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      // One delta at ~0ms; the 60ms window closes and flushes it; the
      // socket close lands at 120ms — AFTER the window.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: {"delta":"visible"}\n\n'));
          setTimeout(() => controller.error(socketCloseError()), 120);
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(60);
    const wrapped = win.wrap(callbacks);

    await assert.rejects(
      readStream(
        {
          logTag: 'cw-test',
          url: 'https://ollama.com/v1/test',
          headers: {},
          body: '{}',
          processLine: sseProcessLine(wrapped),
        },
        wrapped,
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof ConnectionInterruptedError,
          `terminal CIE expected, got ${(error as Error)?.constructor?.name}`,
        );
        return true;
      },
    );

    assert.equal(fetchCalls, 1, 'NO retry after the window closed');
    assert.deepStrictEqual(
      recorded.events,
      ['text:visible'],
      'pre-break output was flushed exactly once',
    );
    assert.equal(recorded.notices.length, 0, 'no notice on a terminal error');
    assert.equal(win.controller.hiddenRetryCount(), 0, 'no hidden retries');
  });

  it('(в) hidden retries are disclosed in diagnostics logs', async function () {
    this.timeout(10000);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode('data: {"delta":"gone"}\n\n'));
            setTimeout(() => controller.error(socketCloseError()), 20);
          },
        });
        return new Response(body, { status: 200 });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const { callbacks } = recordCallbacks();
    const win = createCommitWindow(60);
    const wrapped = win.wrap(callbacks);

    await readStream(
      {
        logTag: 'cw-diag-test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        processLine: sseProcessLine(wrapped),
      },
      wrapped,
    );

    // The retry-eval line + the hidden-retry line both land in the
    // recent-errors buffer the diagnostics report reads from.
    const recent = logger.getRecentErrors().join('\n');
    assert.ok(
      recent.includes('Commit-window hidden retry 1'),
      'hidden retry disclosed via logger.warn',
    );
    assert.ok(
      recent.includes('windowOpen=true'),
      'retry-eval line carries the window state',
    );
    assert.equal(win.controller.hiddenRetryCount(), 1);
  });

  it('zero-byte close after connect-phase retries → ONE extra visible attempt, then terminal', async function () {
    this.timeout(10000);
    let fetchCalls = 0;
    // maxRetries=0 → withRetry does a single POST per readStreamOnce
    // round, so the ZeroByte exhaustion reaches readStream immediately.
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      // Fresh empty stream per call: 200 + headers + immediate EOF.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(60);
    const wrapped = win.wrap(callbacks);

    await readStream(
      {
        logTag: 'cw-zero-test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        processLine: sseProcessLine(wrapped),
      },
      wrapped,
    );

    assert.equal(fetchCalls, 2, 'exactly one extra attempt after exhaustion');
    assert.equal(recorded.notices.length, 1, 'the extra attempt is announced');
    assert.ok(
      recorded.notices[0]!.includes('последнюю автоматическую попытку'),
      recorded.notices[0],
    );
    assert.ok(
      recorded.error instanceof ZeroByteSocketCloseError,
      'terminal error is ZeroByteSocketCloseError after the extra attempt',
    );
    assert.equal(recorded.done, false);
    assert.equal(win.controller.hiddenRetryCount(), 0, 'zero-byte path is not a hidden window retry');
  });

  it('caller cancellation interrupts the hidden-retry backoff → immediate quiet onDone (P2-2)', async function () {
    this.timeout(5000);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      // Attempt 1: one delta, then a socket close 20ms in — inside the
      // 60ms window → hidden retry with a ~1s (±25%) backoff.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: {"delta":"partial"}\n\n'));
          setTimeout(() => controller.error(socketCloseError()), 20);
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const { recorded, callbacks } = recordCallbacks();
    const win = createCommitWindow(60);
    const wrapped = win.wrap(callbacks);
    const source = new vscode.CancellationTokenSource();

    const startedAt = Date.now();
    // Cancel 150ms in: attempt 1 has failed (~20ms), the hidden-retry
    // backoff (750-1250ms) is running. Without the interruptible
    // sleep the stream would stay pending until the FULL backoff
    // elapsed and the next attempt noticed the token.
    setTimeout(() => source.cancel(), 150);

    await readStream(
      {
        logTag: 'cw-cancel-test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        cancellationToken: source.token,
        processLine: sseProcessLine(wrapped),
      },
      wrapped,
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed < 600,
      `cancellation must cut the backoff immediately (took ${elapsed}ms; backoff alone is >=750ms)`,
    );
    assert.equal(recorded.done, true, 'quiet completion (onDone branch)');
    assert.equal(recorded.error, undefined, 'a cancel is not an error');
    assert.equal(fetchCalls, 1, 'no second POST after cancellation');
    assert.equal(win.controller.hiddenRetryCount(), 1, 'the hidden retry was scheduled');
  });
});
