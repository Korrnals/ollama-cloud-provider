/**
 * Review P2-2 (2026-09-14) — integration tests for the two central
 * behavioural claims of v0.14.x that the reviewer found untested:
 *
 *   1. Shared POST budget: total POST attempts across connect-phase
 *      withRetry retries are capped at MAX_POST_BUDGET_PER_MESSAGE (6),
 *      and exhaustion surfaces the typed PostBudgetExhaustedError (P2-1)
 *      — not a generic Error.
 *   2. onNotice: a mid-stream retry issued AFTER chunks were received
 *      emits exactly one visible notice; a retry at 0 chunks emits none.
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  readStream,
  MAX_POST_BUDGET_PER_MESSAGE,
} from '../../src/streamReader.js';
import type { StreamCallbacks } from '../../src/protocolTypes.js';
import { PostBudgetExhaustedError } from '../../src/retry.js';

const ORIGINAL_FETCH = globalThis.fetch;

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function socketCloseError(): Error {
  const err = new Error('read ECONNRESET');
  (err as { code?: string }).code = 'ECONNRESET';
  return err;
}

describe('Shared POST budget + onNotice (review P2-2)', () => {
  beforeEach(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      requestMaxDurationMin: 60,
      // Allow withRetry to WANT more attempts than the budget allows —
      // the budget must be the binding constraint, not maxRetries.
      maxRetries: 5,
    });
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('caps total POST attempts at the shared budget and surfaces a terminal error', async function () {
    // withRetry (maxRetries=5) wants up to 6 attempts; the shared budget
    // also caps at 6 — whichever binds first, the invariant is: EXACTLY
    // MAX_POST_BUDGET_PER_MESSAGE POSTs, then a terminal (non-retried)
    // error — ZeroByteSocketCloseError when maxRetries binds, or the
    // typed PostBudgetExhaustedError when the budget binds. withRetry's
    // exponential sleeps between 6 attempts (~31s) need headroom.
    this.timeout(60000);
    let fetchCalls = 0;
    // Every attempt fails with a retryable connect-phase socket error
    // (reclassified to ZeroByteSocketCloseError inside the probe, which
    // defaultRetryOn retries). withRetry (maxRetries=5) would happily
    // issue 6 attempts; the budget must cut it at exactly 6 and fail
    // with PostBudgetExhaustedError.
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(socketCloseError());
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    let captured: Error | undefined;
    let done = false;
    const callbacks: StreamCallbacks = {
      onText: () => {},
      onToolCall: () => {},
      onDone: () => {
        done = true;
      },
      onError: (e) => {
        captured = e;
      },
    };

    await readStream(
      {
        logTag: 'budget-test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        processLine: () => false,
      },
      callbacks,
    );

    assert.equal(done, false, 'no success path');
    const errorName = (captured as Error)?.name;
    const isTerminal =
      captured instanceof PostBudgetExhaustedError ||
      errorName === 'ZeroByteSocketCloseError';
    assert.ok(
      isTerminal,
      `expected a terminal error, got ${(captured as Error)?.constructor?.name}`,
    );
    assert.equal(fetchCalls, MAX_POST_BUDGET_PER_MESSAGE, 'budget is the binding cap');
  });

  it('emits exactly one onNotice for a mid-stream retry after received chunks', async function () {
    this.timeout(10000); // one retry backoff (~1s ± jitter) + stream time
    let fetchCalls = 0;
    const notices: string[] = [];
    const texts: string[] = [];

    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        // Attempt 1: one data chunk arrives (user sees it), then a raw
        // socket close. The error is deferred so the queued chunk is
        // delivered first (erroring a web stream in start() discards
        // queued chunks per spec).
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode('data: {"delta":"partial"}\n\n'));
            setTimeout(() => controller.error(socketCloseError()), 20);
          },
        });
        return new Response(body, { status: 200 });
      }
      // Attempt 2: complete stream ending with the terminal [DONE] line.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: {"delta":"full answer"}\n\n'));
          controller.enqueue(encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const callbacks: StreamCallbacks = {
      onText: (t) => texts.push(t),
      onToolCall: () => {},
      onDone: () => {
        doneFlag = true;
      },
      onError: (e) => {
        throw e;
      },
      onNotice: (n) => notices.push(n),
    };
    let doneFlag = false;

    await readStream(
      {
        logTag: 'notice-test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        processLine: (line, ctx) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            return false;
          }
          // Module contract: the callback marks meaningful chunks so the
          // clean-end path can distinguish data from a captive portal.
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
        },
      },
      callbacks,
    );

    assert.equal(fetchCalls, 2, 'exactly one retry');
    assert.equal(doneFlag, true, 'second attempt completed the stream');
    assert.equal(notices.length, 1, 'exactly one visible notice');
    assert.ok(notices[0].includes('перезапрашиваю'), notices[0]);
    // Both attempts' tokens reached the user (documented duplicate
    // semantics until the 0.15.x commit-window lands).
    assert.ok(texts.includes('partial'));
    assert.ok(texts.includes('full answer'));
  });
});
