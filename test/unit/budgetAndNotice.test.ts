/**
 * Review P2-2 (2026-09-14) — integration tests for the central
 * behavioural claims of v0.14.x/v0.15.x:
 *
 *   1. Shared POST budget: total POST attempts across connect-phase
 *      withRetry retries are capped at MAX_POST_BUDGET_PER_MESSAGE (6),
 *      and exhaustion surfaces the typed PostBudgetExhaustedError (P2-1)
 *      — not a generic Error.
 *   2. Commit-window (ArchCom §3.4, 0.15.x): an EARLY break (inside
 *      the ~5 s window, nothing flushed to the user) is retried
 *      SILENTLY — exactly one retry, no visible notice, no duplicated
 *      prefix. The former "visible notice on mid-stream retry" case is
 *      gone by design: a break after the window is terminal (see
 *      commitWindow.test.ts), so there is no post-shown retry left to
 *      announce.
 *
 * Flake audit (2026-09-15, stream-stabilization): the caps test
 * previously ran ~31 s of real withRetry backoff inside a 60 s mocha
 * timeout and used an untagged global fetch mock. Both timing pressure
 * and cross-test fetch-mock pollution were removed: the
 * `connectRetryBaseDelayMs` test seam (src/streamReader.ts) shrinks
 * the schedule to a deterministic ~1.25 s, and every mock in this file
 * counts only its own URL (foreign callers get a non-retriable 400).
 * The strict fetchCalls === MAX_POST_BUDGET_PER_MESSAGE assert is kept.
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  readStream,
  MAX_POST_BUDGET_PER_MESSAGE,
} from '../../src/streamReader.js';
import { createCommitWindow } from '../../src/commitWindow.js';
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
    // typed PostBudgetExhaustedError when the budget binds.
    //
    // Flake audit (2026-09-15, stream-stabilization): this test used to
    // burn ~31 s of REAL withRetry sleeps (1+2+4+8+16 s plus 0..500 ms
    // jitter per gap) inside a 60 s mocha timeout, and its untagged
    // global fetch mock counted EVERY fetch issued in the process — so
    // an orphaned retry loop leaked by an earlier test could land one
    // extra call on the mock and break the strict === 6 assert. Both
    // nondeterminism sources are removed here:
    //   1. connectRetryBaseDelayMs=0 (test seam) + pinned Math.random
    //      make the five backoff gaps EXACTLY 250 ms each (~1.25 s
    //      total, deterministic; the 15 s timeout is 12x headroom).
    //   2. the mock counts only OUR url; a foreign caller gets a
    //      non-retriable 400 so any leaked loop dies fast instead of
    //      feeding this counter.
    this.timeout(15000);
    const TARGET_URL = 'https://ollama.com/v1/test-budget-caps';
    let fetchCalls = 0;
    // Every attempt fails with a retryable connect-phase socket error
    // (reclassified to ZeroByteSocketCloseError inside the probe, which
    // defaultRetryOn retries). withRetry (maxRetries=5) would happily
    // issue 6 attempts; the budget must cut it at exactly 6 and fail
    // with PostBudgetExhaustedError.
    globalThis.fetch = (async (url: unknown) => {
      if (url !== TARGET_URL) {
        // Foreign caller (a retry loop leaked from another test):
        // non-retriable status, do not touch our counter.
        return new Response('busy', { status: 400 });
      }
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

    // Pin the jitter: computeDelay = baseDelayMs * 2^attempt +
    // Math.random() * 500 → with base 0 and random()=0.5 every gap is
    // exactly 250 ms. Restored in finally so a failing assert cannot
    // leak the stub into later tests.
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      await readStream(
        {
          logTag: 'budget-test',
          url: TARGET_URL,
          headers: {},
          body: '{}',
          processLine: () => false,
          connectRetryBaseDelayMs: 0,
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
      // STRICT invariant preserved: exactly MAX_POST_BUDGET_PER_MESSAGE
      // POSTs — no more (budget), no fewer (every attempt retried).
      assert.equal(fetchCalls, MAX_POST_BUDGET_PER_MESSAGE, 'budget is the binding cap');
    } finally {
      Math.random = originalRandom;
    }
  });

  it('retries an early break SILENTLY inside the commit window (no notice, no duplicate)', async function () {
    this.timeout(10000); // one hidden-retry backoff (exactly 1000ms pinned) + stream time
    // URL-tagged mock (same hardening as the caps test above): only OUR
    // url moves the counter; foreign callers get a non-retriable 400.
    const TARGET_URL = 'https://ollama.com/v1/test-silent-retry';
    let fetchCalls = 0;
    const notices: string[] = [];
    const texts: string[] = [];

    globalThis.fetch = (async (url: unknown) => {
      if (url !== TARGET_URL) {
        return new Response('busy', { status: 400 });
      }
      fetchCalls += 1;
      if (fetchCalls === 1) {
        // Attempt 1: one data chunk arrives (buffered by the window,
        // NOT shown), then a raw socket close 20ms in — inside the
        // 60ms test window. The error is deferred so the queued chunk
        // is delivered first (erroring a web stream in start()
        // discards queued chunks per spec).
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

    let doneFlag = false;
    const base: StreamCallbacks = {
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
    // ArchCom §3.4 — attach the commit window (60ms test seam instead
    // of the 5s default): the buffered 'partial' delta is RESET on the
    // hidden retry and never reaches the user.
    const win = createCommitWindow(60);
    const callbacks = win.wrap(base);

    // Pin the hidden-retry jitter factor to exactly 1.0 (0.75 + 0.5*0.5):
    // the backoff is exactly 1000ms instead of 750..1250ms.
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      await readStream(
        {
          logTag: 'silent-retry-test',
          url: TARGET_URL,
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
    } finally {
      Math.random = originalRandom;
    }

    assert.equal(fetchCalls, 2, 'exactly one hidden retry');
    assert.equal(doneFlag, true, 'second attempt completed the stream');
    assert.equal(notices.length, 0, 'silent retry issues NO notice');
    // Only the second attempt's tokens reached the user — the discarded
    // prefix cannot leak, no duplication (the ArchCom §3.4 goal).
    assert.deepEqual(texts, ['full answer']);
    assert.equal(win.controller.hiddenRetryCount(), 1, 'disclosed in diagnostics');
  });
});
