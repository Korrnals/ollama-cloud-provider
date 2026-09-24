import { strict as assert } from 'node:assert';
import * as events from 'node:events';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { logger } from '../../src/logger.js';
import { wireRequestLifecycle } from '../../src/httpClient.js';

/**
 * Unit tests for the `wireRequestLifecycle` post-response error gate
 * (RCA 2026-09-24 — TLS BAD_DECRYPT log noise).
 *
 * Root cause under test: `settled` was only set on the failure path,
 * so an `error` arriving on the req AFTER the response had resolved
 * was logged as WARN (up to 740 BAD_DECRYPT WARN lines a day — zero
 * functional impact, pure teardown-artifact noise from the
 * Chromium/Electron network stack that can back `https.request` under
 * VS Code's intercept layer).
 *
 * Strategy: a fake `ClientRequest` built on `events.EventEmitter` is
 * handed to the exported `wireRequestLifecycle` directly. Patching
 * `http.request` is NOT viable in-process — the ESM namespace objects
 * of Node built-ins are read-only under Node 22, so `httpRequest()`
 * cannot be fed a fake transport (the integration suite covers the
 * full paths with live sockets instead).
 *
 * The marker returned by `wireRequestLifecycle` stands in for the
 * transport's response callback: in production the three request
 * paths call it right before `resolve(buildResponse(...))`.
 *
 * Log assertions use two seams:
 *   - `logger.getRecentErrors()` — the ring buffer fed by warn/error
 *     (debug lines never enter it) → "WARN NOT logged" checks;
 *   - a capturing OutputChannel installed via the same seam as
 *     capabilityProbe.test.ts (`createOutputChannel` patch +
 *     `logger.setDebugMode(true)` → the singleton re-grabs the
 *     channel) — debug lines land in the channel only in debug mode.
 */

/**
 * Minimal fake of a `ClientRequest`: an EventEmitter plus `destroy()`
 * (the abort path calls it). The lifecycle also listens on 'socket'
 * (keepalive wiring), which simply never fires for the bare fake.
 */
class FakeClientRequest extends events.EventEmitter {
  public destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * BoringSSL FIPS error text — the exact shape observed in the debug
 * log (lib=0x1e CIPHER, reason=0x65 BAD_DECRYPT, Chromium-only source
 * path). Used as the post-response teardown artifact.
 */
function makeBadDecryptError(): Error {
  return new Error(
    '10187663221056:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT:../../third_party/boringssl/src/crypto/fipsmodule/cipher/e_aes.cc.inc:847:',
  );
}

/**
 * Log capture — same seam as capabilityProbe.test.ts: replace the
 * vscode OutputChannel factory, force the logger singleton to re-grab
 * its channel (`setDebugMode(true)` → dispose + re-create via the
 * patched factory), and collect every appended line.
 */
let capturedLogLines: string[] = [];
let originalCreateOutputChannel:
  | typeof vscode.window.createOutputChannel
  | undefined;

function startLogCapture(): void {
  capturedLogLines = [];
  const capturingChannel = {
    name: 'Ollama Cloud (Debug)',
    appendLine: (line: string) => {
      capturedLogLines.push(line);
    },
    show: () => undefined,
    dispose: () => undefined,
  };
  originalCreateOutputChannel = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (() =>
    capturingChannel) as unknown as typeof vscode.window.createOutputChannel;
  logger.setDebugMode(true);
}

function stopLogCapture(): void {
  if (originalCreateOutputChannel !== undefined) {
    vscode.window.createOutputChannel = originalCreateOutputChannel;
    originalCreateOutputChannel = undefined;
  }
  logger.setDebugMode(false);
}

/** Current size of the warn/error recent-errors ring buffer. */
function recentErrorCount(): number {
  return logger.getRecentErrors().length;
}

function recentErrorsContain(fragment: string): boolean {
  return logger
    .getRecentErrors()
    .some((line) => line.includes(fragment));
}

/**
 * The recent-errors ring buffer is a process-wide singleton without a
 * reset API, so every "no WARN" assertion must be DELTA-based against
 * the count captured right before the triggering event (earlier tests
 * legitimately leave WARN entries behind).
 */

describe('httpClient.wireRequestLifecycle — post-response error gate', () => {
  beforeEach(() => {
    startLogCapture();
  });

  afterEach(() => {
    stopLogCapture();
  });

  it('a. post-response BAD_DECRYPT is silenced to debug: no WARN, no reject, boringssl tag present', () => {
    const req = new FakeClientRequest();
    let rejectCalled = false;
    const markResponseReceived = wireRequestLifecycle(
      req as unknown as http.ClientRequest,
      {},
      'https://ollama.com/v1/chat/completions',
      () => {
        rejectCalled = true;
      },
    );

    // Success path: the transport calls the marker before resolving.
    markResponseReceived();

    // Teardown artifact arrives AFTER the settled response.
    const warnsBefore = recentErrorCount();
    req.emit('error', makeBadDecryptError());

    assert.equal(
      recentErrorCount(),
      warnsBefore,
      'post-response error must NOT log WARN',
    );
    assert.equal(rejectCalled, false, 'reject must not be called post-response');
    const debugJoined = capturedLogLines.join('\n');
    assert.ok(
      debugJoined.includes('post-response error on settled request'),
      'debug line must be logged for the post-response error',
    );
    assert.ok(
      debugJoined.includes('(boringssl teardown artifact)'),
      'boringssl teardown artifact tag must be present',
    );
    assert.ok(
      debugJoined.includes('BAD_DECRYPT'),
      'debug line carries the error message',
    );
  });

  it('a2. post-response non-boringssl error is silenced without the artifact tag', () => {
    const req = new FakeClientRequest();
    let rejectCalled = false;
    const markResponseReceived = wireRequestLifecycle(
      req as unknown as http.ClientRequest,
      {},
      'https://ollama.com/v1/models',
      () => {
        rejectCalled = true;
      },
    );
    markResponseReceived();

    const warnsBefore = recentErrorCount();
    req.emit('error', new Error('some late teardown hiccup'));

    assert.equal(
      recentErrorCount(),
      warnsBefore,
      'no WARN for a non-boringssl late error',
    );
    assert.equal(rejectCalled, false);
    const debugJoined = capturedLogLines.join('\n');
    assert.ok(debugJoined.includes('post-response error on settled request'));
    assert.ok(
      !debugJoined.includes('(boringssl teardown artifact)'),
      'no boringssl tag for a non-boringssl message',
    );
  });

  it('b. pre-response error keeps WARN + reject (ECONNRESET-like, existing path)', async () => {
    const req = new FakeClientRequest();
    let rejectError: Error | undefined;
    const settled = new Promise<void>((resolve) => {
      wireRequestLifecycle(
        req as unknown as http.ClientRequest,
        {},
        'https://ollama.com/v1/chat/completions',
        (error: Error) => {
          rejectError = error;
          resolve();
        },
      );
    });

    const err = new Error('read ECONNRESET') as Error & { code?: string };
    err.code = 'ECONNRESET';
    req.emit('error', err);
    await settled;

    assert.ok(
      recentErrorsContain('request to ollama.com failed'),
      'pre-response error must log WARN',
    );
    assert.equal(rejectError, err, 'pre-response error must reject');
  });

  it('c. pre-response abort logs WARN with AbortError (existing behaviour)', async () => {
    const req = new FakeClientRequest();
    const controller = new AbortController();
    let rejectError: Error | undefined;
    const settled = new Promise<void>((resolve) => {
      wireRequestLifecycle(
        req as unknown as http.ClientRequest,
        { signal: controller.signal },
        'https://ollama.com/v1/chat/completions',
        (error: Error) => {
          rejectError = error;
          resolve();
        },
      );
    });

    controller.abort();
    await settled;

    assert.ok(
      recentErrorsContain('request to ollama.com failed'),
      'pre-response abort must log WARN',
    );
    assert.ok(rejectError instanceof Error);
    assert.equal(rejectError?.name, 'AbortError');
    assert.equal(req.destroyed, true, 'abort destroys the socket');
  });

  it('d. post-response abort still destroys the socket but logs no WARN (mid-stream cancel regression guard)', () => {
    const req = new FakeClientRequest();
    let rejectCalled = false;
    const controller = new AbortController();
    const markResponseReceived = wireRequestLifecycle(
      req as unknown as http.ClientRequest,
      { signal: controller.signal },
      'https://ollama.com/v1/chat/completions',
      () => {
        rejectCalled = true;
      },
    );
    markResponseReceived();

    // Consumer aborts mid-stream AFTER the response arrived: the abort
    // listener must still destroy the socket (streaming cancel relies
    // on it), but fail() must stay out of WARN/reject.
    const warnsBefore = recentErrorCount();
    controller.abort();
    // Node delivers the destroy reason as a req 'error' event.
    req.emit('error', new Error('The operation was aborted'));

    assert.equal(req.destroyed, true, 'socket still destroyed on abort');
    assert.equal(
      recentErrorCount(),
      warnsBefore,
      'no WARN after response received',
    );
    assert.equal(rejectCalled, false, 'no reject after response received');
  });
});
