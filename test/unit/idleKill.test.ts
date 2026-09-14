/**
 * ArchCom 2026-09-14 (train A) — tests for the idle-kill
 * classification and SSE comment-frame tolerance.
 *
 *   - classifyIdleKill: threshold boundary, anchor selection
 *     (lastChunkAt for >0 chunks, headersAt for 0 chunks), undefined
 *     anchors, non-integer gaps.
 *   - SSE comment frames (`: ping` keepalive lines) pass through the
 *     reader without breaking parsing — mitigation practice from the
 *     LiteLLM RCA of the same bug class (ollama/ollama#16108).
 *   - UpstreamIdleTimeoutError is terminal: defaultRetryOn returns
 *     false and isSocketCloseError does not reclassify it.
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  classifyIdleKill,
  IDLE_KILL_QUIET_GAP_MS,
  readStream,
} from '../../src/streamReader.js';
import {
  UpstreamIdleTimeoutError,
  defaultRetryOn,
  isSocketCloseError,
} from '../../src/retry.js';

describe('classifyIdleKill (ArchCom 2026-09-14 train A)', () => {
  it('returns undefined below the quiet-gap threshold', () => {
    const now = 1_000_000;
    const result = classifyIdleKill(3, now - (IDLE_KILL_QUIET_GAP_MS - 1), now - now, now);
    assert.strictEqual(result, undefined);
  });

  it('classifies a mid-stream idle kill at the exact threshold', () => {
    const now = 1_000_000;
    const result = classifyIdleKill(
      3,
      now - IDLE_KILL_QUIET_GAP_MS,
      undefined,
      now,
    );
    assert.ok(result instanceof UpstreamIdleTimeoutError);
    assert.strictEqual(result.quietMs, IDLE_KILL_QUIET_GAP_MS);
    assert.strictEqual(result.chunksReceived, 3);
  });

  it('0-chunk case anchors on headersAt (thinking pause before first byte)', () => {
    const now = 1_000_000;
    // lastChunkAt set (stale from a previous attempt shape) but chunks=0
    // → anchor must be headersAt, NOT lastChunkAt.
    const headersAt = now - (IDLE_KILL_QUIET_GAP_MS + 5_000);
    const lastChunkAt = now - 1_000;
    const result = classifyIdleKill(0, lastChunkAt, headersAt, now);
    assert.ok(result instanceof UpstreamIdleTimeoutError);
    assert.strictEqual(result.chunksReceived, 0);
    assert.ok(result.quietMs >= IDLE_KILL_QUIET_GAP_MS);
  });

  it('0-chunk case with a short header gap does not classify', () => {
    const now = 1_000_000;
    const result = classifyIdleKill(0, undefined, now - 1_000, now);
    assert.strictEqual(result, undefined);
  });

  it('undefined anchors never classify', () => {
    assert.strictEqual(classifyIdleKill(0, undefined, undefined, 123), undefined);
    // chunks > 0 but no lastChunkAt (should not happen in practice)
    assert.strictEqual(classifyIdleKill(2, undefined, 0, 123), undefined);
  });
});

describe('UpstreamIdleTimeoutError taxonomy', () => {
  it('defaultRetryOn returns false — never auto-retried', () => {
    const error = new UpstreamIdleTimeoutError(120_000, 0);
    assert.strictEqual(defaultRetryOn(error), false);
  });

  it('isSocketCloseError does not reclassify it', () => {
    const error = new UpstreamIdleTimeoutError(120_000, 5);
    assert.strictEqual(isSocketCloseError(error), false);
  });

  it('message names the quiet gap in seconds', () => {
    const error = new UpstreamIdleTimeoutError(145_000, 0);
    assert.ok(error.message.includes('145s'), error.message);
  });
});

describe('SSE comment-frame tolerance (#16108 mitigation)', () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  before(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      requestMaxDurationMin: 60,
      maxRetries: 0,
    });
  });

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('`: ping` keepalive lines are skipped without breaking the stream', async () => {
    const seenLines: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(': ping\n\n'));
        controller.enqueue(encoder.encode('data: {"delta":"hello"}\n\n'));
        controller.enqueue(encoder.encode(': ping\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = (async () =>
      new Response(body, { status: 200 })) as typeof fetch;

    let done = false;
    let error: Error | undefined;
    const callbacks: import('../../src/protocolTypes.js').StreamCallbacks = {
      onText: () => {},
      onToolCall: () => {},
      onDone: () => {
        done = true;
      },
      onError: (e) => {
        error = e;
      },
    };
    await readStream(
      {
        logTag: 'test',
        url: 'https://ollama.com/v1/test',
        headers: {},
        body: '{}',
        // Condition #2 of the module contract: the terminal condition
        // belongs to the callback — on `[DONE]` it finalizes the
        // stream itself (callbacks.onDone); the reader does not.
        processLine: (line) => {
          seenLines.push(line);
          if (line.trim() === 'data: [DONE]') {
            callbacks.onDone();
            return true;
          }
          return false;
        },
      },
      callbacks,
    );

    assert.strictEqual(error, undefined);
    assert.strictEqual(done, true);
    // Comment frames must reach the callback untouched (the callback
    // contract says EVERY line is delivered; the ollamaClient /
    // responsesClient wrappers ignore `:` lines themselves). What
    // matters for tolerance: the reader does not choke, does not treat
    // them as data, and the stream completes.
    assert.ok(seenLines.includes(': ping'));
    assert.ok(seenLines.some((l) => l.startsWith('data:')));
  });
});
