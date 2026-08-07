import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  HttpError,
  ZeroByteSocketCloseError,
  ConnectionInterruptedError,
  defaultRetryOn,
  httpErrorFromResponse,
  isRetriableHttpStatus,
  isSocketCloseError,
  withRetry,
} from '../../src/retry.js';

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

function makeResponse(headers: Record<string, string>, status = 429): Response {
  return new Response('{"error":{"message":"rate"}}', {
    status,
    headers: new Headers(headers),
  });
}

describe('retry.withRetry — backoff', () => {
  beforeEach(() => {
    setConfig({ maxRetries: 3 });
  });

  it('retries up to maxRetries and then throws the last error', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new HttpError(429, 'rate');
        }
        return 'ok';
      },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('throws immediately on a non-retriable error (does not burn retries)', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(400, 'bad request');
        },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
      (err: Error) => err.message === 'bad request',
    );
    assert.equal(calls, 1, 'must not retry on non-retriable error');
  });

  it('respects Retry-After delta-seconds', async () => {
    let calls = 0;
    let observedDelay = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new HttpError(429, 'rate', 30); // 30ms retry-after
        }
        observedDelay = Date.now() - start;
        return 'ok';
      },
      { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 30000 },
    );
    // We can't assert exact timing, but observedDelay should be roughly
    // >= 30ms (retryAfterMs) and far below the baseDelay (1000ms).
    assert.ok(
      observedDelay >= 25,
      `expected delay near retryAfterMs, got ${observedDelay}ms`,
    );
  });

  it('respects Retry-After HTTP-date form', async () => {
    const futureMs = Date.now() + 50; // 50ms in the future
    const httpDate = new Date(futureMs).toUTCString();
    const response = makeResponse({ 'retry-after': httpDate });
    const err = await httpErrorFromResponse(response, 'rate');
    assert.ok(err.retryAfterMs !== undefined);
    // The parsed delay should be roughly 50ms (within tolerance).
    assert.ok(
      err.retryAfterMs! >= 0 && err.retryAfterMs! < 200,
      `expected ~50ms, got ${err.retryAfterMs}ms`,
    );
  });

  it('clamps retryAfterMs to maxDelayMs', async () => {
    let calls = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          // retryAfterMs=100000 but maxDelayMs=5 — must clamp to 5.
          throw new HttpError(429, 'rate', 100000);
        }
        return Date.now() - start;
      },
      { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 5 },
    );
    assert.equal(calls, 2);
  });

  it('defaultRetryOn retries HttpError 429 and 5xx, not 4xx', () => {
    assert.equal(defaultRetryOn(new HttpError(429, 'r')), true);
    assert.equal(defaultRetryOn(new HttpError(500, 'r')), true);
    assert.equal(defaultRetryOn(new HttpError(503, 'r')), true);
    assert.equal(defaultRetryOn(new HttpError(400, 'r')), false);
    assert.equal(defaultRetryOn(new HttpError(404, 'r')), false);
  });

  it('defaultRetryOn retries TypeError (network error)', () => {
    assert.equal(defaultRetryOn(new TypeError('fetch failed')), true);
  });

  it('defaultRetryOn retries AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.equal(defaultRetryOn(err), true);
  });

  it('returns true for ZeroByteSocketCloseError (0-byte socket close is retryable)', () => {
    assert.strictEqual(defaultRetryOn(new ZeroByteSocketCloseError()), true);
  });

  it('does NOT retry when caller retryOn returns false (caller-cancel)', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(429, 'rate');
        },
        {
          maxRetries: 3,
          baseDelayMs: 1,
          retryOn: () => false, // caller cancels — never retry
        },
      ),
      (err: Error) => err.message === 'rate',
    );
    assert.equal(calls, 1);
  });

  it('isRetriableHttpStatus boundary: 499 false, 500 true', () => {
    assert.equal(isRetriableHttpStatus(499), false);
    assert.equal(isRetriableHttpStatus(500), true);
    assert.equal(isRetriableHttpStatus(429), true);
    assert.equal(isRetriableHttpStatus(404), false);
  });
});

/**
 * ADR 0008 Phase 2 level-4 — raw Node socket-close errors (TLS socket
 * closed, ECONNRESET, "aborted at TLSSocket.socketCloseListener") must
 * be detected and classified, not surfaced as raw stack traces.
 */
describe('retry — socket-close error detection (ADR 0008 Phase 2 level-4)', () => {
  describe('isSocketCloseError', () => {
    it('detects the literal "aborted" Node HTTP client message', () => {
      const err = new Error('aborted');
      assert.strictEqual(isSocketCloseError(err), true);
    });

    it('detects "aborted at TLSSocket.socketCloseListener ..." framing', () => {
      const err = new Error(
        'aborted at TLSSocket.socketCloseListener (node:_http_client:553:19)',
      );
      assert.strictEqual(isSocketCloseError(err), true);
    });

    it('detects "socket hang up" framing', () => {
      assert.strictEqual(
        isSocketCloseError(new Error('socket hang up')),
        true,
      );
    });

    it('detects libuv code ECONNRESET', () => {
      const err = new Error('read ECONNRESET') as Error & {
        code?: string;
      };
      err.code = 'ECONNRESET';
      assert.strictEqual(isSocketCloseError(err), true);
    });

    it('detects "read ECONNRESET" message framing (no code)', () => {
      assert.strictEqual(
        isSocketCloseError(new Error('read ECONNRESET')),
        true,
      );
    });

    it('detects "connect ECONNREFUSED" message framing', () => {
      assert.strictEqual(
        isSocketCloseError(new Error('connect ECONNREFUSED 127.0.0.1:8080')),
        true,
      );
    });

    it('detects "write EPIPE" message framing', () => {
      assert.strictEqual(isSocketCloseError(new Error('write EPIPE')), true);
    });

    it('does NOT match a typed error from our own code', () => {
      assert.strictEqual(
        isSocketCloseError(new HttpError(502, 'bad gateway')),
        false,
      );
      assert.strictEqual(
        isSocketCloseError(new ZeroByteSocketCloseError()),
        false,
      );
      assert.strictEqual(
        isSocketCloseError(new ConnectionInterruptedError(3)),
        false,
      );
    });

    it('does NOT match an unrelated plain Error', () => {
      assert.strictEqual(
        isSocketCloseError(new Error('something else went wrong')),
        false,
      );
    });

    it('does NOT match non-Error values', () => {
      assert.strictEqual(isSocketCloseError(undefined), false);
      assert.strictEqual(isSocketCloseError(null), false);
      assert.strictEqual(isSocketCloseError('aborted'), false);
      assert.strictEqual(isSocketCloseError({ message: 'aborted' }), false);
    });

    it('does NOT false-match a coincidental libuv code substring', () => {
      // The regex requires the libuv framing verb (read/write/connect)
      // before the code — a plain sentence containing ECONNRESET must
      // NOT match unless it carries the framing.
      assert.strictEqual(
        isSocketCloseError(new Error('the docs mention ECONNRESET here')),
        false,
      );
    });
  });

  describe('ConnectionInterruptedError', () => {
    it('records the chunk count in its message and field', () => {
      const err = new ConnectionInterruptedError(5);
      assert.strictEqual(err.name, 'ConnectionInterruptedError');
      assert.strictEqual(err.chunksReceived, 5);
      assert.match(err.message, /connection interrupted after 5 chunk/);
    });

    it('throws RangeError when constructed with zero chunks (invalid state)', () => {
      // ADR 0008 taxonomy — 0 chunks MUST be ZeroByteSocketCloseError,
      // never ConnectionInterruptedError. The constructor enforces this
      // invariant by rejecting the invalid state at construction time.
      assert.throws(
        () => new ConnectionInterruptedError(0),
        RangeError,
        'constructor must reject chunksReceived <= 0',
      );
    });

    it('throws RangeError when constructed with negative chunks (invalid state)', () => {
      assert.throws(
        () => new ConnectionInterruptedError(-1),
        RangeError,
        'constructor must reject chunksReceived <= 0',
      );
    });
  });

  describe('defaultRetryOn — socket-close classification', () => {
    it('retries a raw socket-close error (connect-phase equivalent)', () => {
      assert.strictEqual(
        defaultRetryOn(new Error('aborted')),
        true,
      );
      const resetErr = new Error('read ECONNRESET') as Error & {
        code?: string;
      };
      resetErr.code = 'ECONNRESET';
      assert.strictEqual(defaultRetryOn(resetErr), true);
    });

    it('does NOT retry ConnectionInterruptedError (mid-stream, terminal)', () => {
      assert.strictEqual(
        defaultRetryOn(new ConnectionInterruptedError(3)),
        false,
      );
    });

    it('still retries ZeroByteSocketCloseError (0-byte close, connect-equiv)', () => {
      assert.strictEqual(
        defaultRetryOn(new ZeroByteSocketCloseError()),
        true,
      );
    });
  });
});