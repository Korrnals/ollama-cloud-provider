/**
 * ADR 0010 — shared streaming lifecycle for Ollama Cloud clients.
 *
 * CONDITION #7 — this is NOT a generic SSE reader. This module is
 * tightly coupled to `retry.ts` and its error classes
 * (`ConnectTimeoutError`, `InactivityTimeoutError`, `MidStreamError`,
 * `ZeroByteSocketCloseError`, `ConnectionInterruptedError`,
 * `MaxDurationError`). Those classes encode Ollama Cloud's
 * non-idempotency contract (POST `/chat/completions` and
 * `/v1/responses` are NOT idempotent — retrying mid-stream would bill
 * the user twice, per ADR 0001 "provider-not-agent" and ADR 0005
 * "No mid-stream retry") and the token-billing model (billing happens
 * via the `usage` field emitted inside stream chunks, so the 0-chunk /
 * >0-chunk boundary determines whether a retry is safe).
 *
 * A future reader MUST NOT treat this as a reusable, protocol-agnostic
 * SSE parser. The error taxonomy, the three-timer architecture, the
 * per-attempt AbortController wiring, and the socket-close
 * reclassification are all domain-specific. Extracting a generic reader
 * would require re-deriving these semantics or losing them.
 *
 * ## Module boundary (ADR 0010)
 *
 * This module OWNS (invariant lifecycle):
 *   - Three timers (max-duration, inactivity soft+grace) — ADR 0005
 *   - `withRetry` connect wrapper + per-attempt AbortController
 *   - Reader loop + 1 MiB buffer cap
 *   - `chunksReceived` accounting + 0-chunk / >0-chunk boundary
 *   - Socket-close reclassification (ADR 0008)
 *   - AbortError routing by `abortReason`
 *   - `finally` cleanup + `resolve*` helpers + constants
 *
 * The CLIENT owns (endpoint-specific):
 *   - URL resolution (`chatUrl`, `responsesUrl`)
 *   - Body construction (compat / native / responses)
 *   - `assertBaseUrlAllowedOrThrow` (SEC-03 whitelist)
 *   - Line parser (`processLine` / `processResponsesLine`)
 *   - Protocol state (`pendingToolCalls`, `pendingEvent`)
 *   - `flushToolCalls` (compat only) — passed as optional `finalize`
 *   - Headers build (apiKey)
 *
 * ## Conditions (ADR 0010 — all 8 mandatory)
 *
 * 1. Callback injection (not strategy pattern) — the only variant is
 *    the line-parsing function.
 * 2. Callback carries the terminal condition — the module does NOT
 *    hardcode `[DONE]` or `response.completed`.
 * 3. `chunksReceived` is incremented by this module, not by the
 *    callback.
 * 4. Typed errors pass through — `MidStreamError` and peers pass
 *    through the catch WITHOUT reclassification via
 *    `isSocketCloseError` (they are excluded by `isSocketCloseError`
 *    itself, but the catch ordering makes this explicit).
 * 5. `ConnectionInterruptedError` constructor-guard (`chunksReceived
 *    > 0`) remains as defense-in-depth.
 * 6. Test-first — `test/unit/streamReader.test.ts` was written before
 *    this extraction.
 * 7. This header doc documents the `retry.ts` coupling.
 * 8. Single PR `refactor/sse-parser-shared`.
 */

import type { CancellationToken } from 'vscode';
import * as vscode from 'vscode';
import { httpRequest, type HttpResponseLike } from './httpClient.js';
import { logger, redactSensitive } from './logger.js';
import type { StreamCallbacks } from './protocolTypes.js';
import {
  ConnectTimeoutError,
  ConnectionInterruptedError,
  InactivityTimeoutError,
  MaxDurationError,
  ZeroByteSocketCloseError,
  defaultRetryOn,
  httpErrorFromResponse,
  isSocketCloseError,
  withRetry,
} from './retry.js';

// -------------------------------------------------------------------------
// ADR 0005 — three timers. Same defaults/maxes as the former per-client
// constants (now centralized here). The resolver helpers are shared
// (not duplicated) — the deprecation-warning flag is module-level.
// v0.9.0 — connect default raised to 60s (1 min), inactivity default
// raised to 300s (5 min) with a soft/grace extension (see
// resetInactivity). The max stays at 600s (10 min)... actually the max
// duration default is 1800000 (30 min).
// -------------------------------------------------------------------------
const REQUEST_CONNECT_TIMEOUT_MAX_MS = 120000;
const REQUEST_CONNECT_TIMEOUT_DEFAULT_MS = 60000;

const REQUEST_INACTIVITY_TIMEOUT_MAX_MS = 600000;
const REQUEST_INACTIVITY_TIMEOUT_DEFAULT_MS = 300000;
// v0.9.0 — soft threshold: when the inactivity timer first fires at this
// duration, instead of killing the stream, we log a warning and extend
// to the full inactivityTimeoutMs grace period. Only the SECOND fire
// (hard kill) aborts. Must be <= REQUEST_INACTIVITY_TIMEOUT_DEFAULT_MS.
const REQUEST_INACTIVITY_SOFT_THRESHOLD_MS = 120000;

const REQUEST_MAX_DURATION_MAX_MS = 3600000;
const REQUEST_MAX_DURATION_DEFAULT_MS = 1800000;

// Legacy single-timer clamp — kept for the deprecation alias. The
// default is intentionally unused (new default is
// REQUEST_MAX_DURATION_DEFAULT_MS); the alias only applies when the
// user explicitly set requestTimeoutMs.
const REQUEST_TIMEOUT_MAX_MS = 600000;

// MEDIUM-2 — cap the SSE buffer at 1 MiB. A well-formed stream emits
// newline-delimited chunks, so the buffer between line splits stays
// small. A hostile/malformed stream with no newlines would grow it
// without bound; this cap turns that into a bounded, reported error.
const MAX_SSE_BUFFER_BYTES = 1048576;

// -------------------------------------------------------------------------
// Public interface — callback injection (condition #1).
// -------------------------------------------------------------------------

/**
 * Context passed to the line-processing callback on each line. Provides
 * the `resetInactivity` function so keep-alive comments (`: keep-alive`)
 * can reset the inactivity timer — the callback decides whether a line
 * is a keep-alive, the module owns the timer.
 */
export interface StreamLineContext {
  resetInactivity: () => void;
}

/**
 * Processes a single line from the stream. Returns `true` when the
 * stream is done (terminal condition is the callback's responsibility —
 * condition #2: the shared module never hardcodes `[DONE]` or
 * `response.completed`).
 *
 * The callback MAY throw a typed error (e.g. `MidStreamError` when the
 * server sends an error event). Such errors pass through the module's
 * catch UNCHANGED — condition #4: they are NOT reclassified via
 * `isSocketCloseError`.
 */
export type StreamLineProcessor = (
  line: string,
  ctx: StreamLineContext,
) => boolean;

/**
 * Optional finalizer invoked on a clean stream end (the reader loop
 * exhausted without the callback returning `true`). The compat chat
 * client uses this to flush accumulated pending tool calls before
 * `onDone`. The responses client omits it (no tool-call accumulation).
 */
export type StreamFinalizer = (callbacks: StreamCallbacks) => void;

/**
 * Options for `readStream`. The client builds these from its
 * endpoint-specific context; the module consumes them to drive the
 * invariant lifecycle.
 */
export interface StreamReaderOptions {
  /**
   * Tag prepended to log lines (e.g. `'Ollama Cloud'` or
   * `'Ollama Cloud (/v1/responses)'`). Lets each client's timer-fire
   * logs be distinguished in the output channel.
   */
  logTag: string;
  /** Absolute fetch URL — already validated against the SEC-03 whitelist. */
  url: string;
  /** Request headers (including Authorization when an API key is set). */
  headers: Record<string, string>;
  /** Serialized request body. */
  body: string;
  /** Optional caller cancellation token (VS Code CancellationToken). */
  cancellationToken?: CancellationToken;    /**
     * Base URL for sidecar health-check probe (ArchCom 0011). When set,
     * the inactivity soft-threshold fires a `GET {probeUrl}/v1/models`
     * request instead of blindly extending grace. Probe success →
     * extend grace 5 min (max 3 extensions). Probe fail (N=2
     * consecutive) → kill. 429 → neutral (extend grace).
     */
    probeUrl?: string;
    /** Auth headers for the sidecar probe (same as streaming request). */
    probeHeaders?: Record<string, string>;  /** Line-processing callback — the endpoint-specific parser. */
  processLine: StreamLineProcessor;
  /** Optional finalizer for clean stream-end (compat flushToolCalls). */
  finalize?: StreamFinalizer;
}

/**
 * Extracted from both clients (ADR 0010). The three-timer architecture,
 * the withRetry connect wrapper, the reader loop + buffer cap, the
 * socket-close reclassification, and the AbortError routing all live
 * here. The client injects endpoint-specific parsing via `processLine`
 * and optional `finalize`.
 *
 * Behavior-preserving relative to the former inline implementations in
 * `ollamaClient.streamChat` and `responsesClient.streamResponses`.
 */
export async function readStream(
  options: StreamReaderOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  const { logTag, url, headers, body, cancellationToken } = options;

  // ADR 0005 — three timers replace the single end-to-end setTimeout.
  //   connect      — wraps fetch only, retryable, 60s default
  //   inactivity   — resets per chunk + per :keep-alive, NO retry, 300s
  //   maxDuration  — never reset, NO retry, 30 min safety cap
  // No mid-stream retry: POST endpoints are not idempotent.
  const controller = new AbortController();
  const connectTimeoutMs = resolveConnectTimeoutMs();
  const inactivityTimeoutMs = resolveInactivityTimeoutMs();
  const maxDurationMs = resolveMaxDurationMs();

  logger.debug(
    `${logTag}: readStream START — connect=${connectTimeoutMs}ms, inactivity=${inactivityTimeoutMs}ms, maxDuration=${maxDurationMs}ms, probeUrl=${options.probeUrl ?? 'none'}`,
  );

  // Tagged abort reason — the catch block routes by this tag to emit
  // the right user-facing message and to decide onDone vs onError.
  type AbortReason =
    | 'connect'
    | 'inactivity'
    | 'maxDuration'
    | 'cancel'
    | null;
  let abortReason: AbortReason = null;

  // Max-duration: one setTimeout at start, never reset, cleared in finally.
  const maxDurationHandle = setTimeout(() => {
    abortReason = 'maxDuration';
    logger.error(
      `${logTag}: exceeded max stream duration (${maxDurationMs}ms)`,
    );
    controller.abort();
  }, maxDurationMs);

  // Inactivity: started after fetch resolves (first byte), reset per
  // chunk + per :keep-alive. Declared here so the finally block can
  // clear it from both the stream path and the early-throw path.
  // v0.9.0 — soft/grace period: the FIRST fire at the soft threshold
  // (120s) logs a warning and extends the timer to the full
  // `inactivityTimeoutMs` grace period (300s default). Only the SECOND
  // fire hard-kills the stream. This accommodates long reasoning
  // models that go silent between the reasoning phase and token
  // emission without being truly dead.
  let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
  let inactivitySoftFired = false;
  const resetInactivity = (): void => {
    if (inactivityHandle !== undefined) {
      clearTimeout(inactivityHandle);
    }
    inactivitySoftFired = false;
    // Short-timeout path: when the configured inactivity timeout is
    // at or below the soft threshold (tests, or users who explicitly
    // want a short timeout), fire HARD directly at the configured
    // duration. No soft extension — this is the pre-v0.9.0 behaviour
    // for short timeouts and keeps a short test budget satisfied.
    if (inactivityTimeoutMs <= REQUEST_INACTIVITY_SOFT_THRESHOLD_MS) {
      inactivityHandle = setTimeout(() => {
        abortReason = 'inactivity';
        logger.error(
          `${logTag}: stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
        );
        controller.abort();
      }, inactivityTimeoutMs);
      return;
    }
    // Long-timeout path: soft threshold + grace extension. The FIRST
    // fire at the soft threshold logs a warning and extends the timer
    // to the full `inactivityTimeoutMs` grace period (300s default).
    // Only the SECOND fire hard-kills the stream.
    inactivityHandle = setTimeout(() => {
      if (!inactivitySoftFired) {
        // Soft fire — extend to the full grace period.
        inactivitySoftFired = true;
        if (inactivityHandle !== undefined) {
          clearTimeout(inactivityHandle);
        }
        logger.warn(
          `${logTag}: stream stalled for ${REQUEST_INACTIVITY_SOFT_THRESHOLD_MS}ms — extending to ${inactivityTimeoutMs}ms grace period`,
        );
        inactivityHandle = setTimeout(() => {
          abortReason = 'inactivity';
          logger.error(
            `${logTag}: stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
          );
          controller.abort();
        }, inactivityTimeoutMs);
        return;
      }
      // Should not reach here — the soft-fire callback re-arms with a
      // fresh timer; this branch is defensive.
      abortReason = 'inactivity';
      logger.error(
        `${logTag}: stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
      );
      controller.abort();
    }, REQUEST_INACTIVITY_SOFT_THRESHOLD_MS);
  };
  const clearInactivity = (): void => {
    if (inactivityHandle !== undefined) {
      clearTimeout(inactivityHandle);
      inactivityHandle = undefined;
    }
  };

  // Count of chunks received — condition #3: incremented by this module,
  // NOT by the callback. Used by the catch block to distinguish
  // connect/first-token (0 chunks) from mid-stream (>0 chunks) for
  // error messages. NOT used for retry decisions (no retry regardless).
  let chunksReceived = 0;

  // Combine the caller's CancellationToken with our timers. See the
  // race note below — a cancel that arrived during async setup before
  // readStream was entered must be detected synchronously.
  const cancelListener = cancellationToken?.onCancellationRequested(() => {
    abortReason = 'cancel';
    controller.abort();
  });
  if (cancellationToken?.isCancellationRequested) {
    abortReason = 'cancel';
    controller.abort();
  }

  let done = false;

  // ADR 0005 — per-attempt abort wiring. Declared in the function
  // scope (not inside `try`) so the outer `finally` can detach the
  // main→attempt listener once the stream is done.
  let streamMainAbortListener: (() => void) | undefined;

  // StreamLineContext passed to processLine — exposes resetInactivity
  // so keep-alive comments reset the inactivity timer.
  const lineCtx: StreamLineContext = { resetInactivity };

  try {
    // Issue 13 / ADR 0005 — retry the INITIAL CONNECTION only.
    // `withRetry` wraps just the `fetch` + status check; the body
    // reader loop is outside the wrapper. Connect-phase timeouts
    // (ConnectTimeoutError) are retriable; stream errors are terminal.
    const retryOn = (error: unknown): boolean => {
      if (cancellationToken?.isCancellationRequested) {
        return false;
      }
      // Do not retry on our own intentional aborts once a stream has
      // started — but the connect-phase AbortError from the connect
      // timer is wrapped as ConnectTimeoutError by the fetch wrapper
      // below, so a raw AbortError here means caller-cancel or an
      // ambiguous network abort: default to not retrying.
      if (error instanceof Error && error.name === 'AbortError') {
        return false;
      }
      return defaultRetryOn(error);
    };

    // ADR 0005 — connect timer uses a PER-ATTEMPT AbortController,
    // NOT the main `controller`. Each retry attempt gets its own fresh
    // `attemptController`. The main `controller` (cancel / maxDuration /
    // inactivity) is wired to abort the attempt controller too, so a
    // caller cancel or max-duration fire still short-circuits the
    // in-flight fetch AND the stream reader loop. The wire must stay
    // live for the entire stream phase (not just the connect phase)
    // because the stream body is tied to `attemptController.signal`.
    const response = await withRetry(
      async () => {
        // Detach any previous attempt's main→attempt wire before
        // installing a fresh one.
        if (streamMainAbortListener) {
          controller.signal.removeEventListener('abort', streamMainAbortListener);
          streamMainAbortListener = undefined;
        }

        const attemptController = new AbortController();
        const connectHandle = setTimeout(() => {
          if (abortReason === null) {
            abortReason = 'connect';
          }
          attemptController.abort();
        }, connectTimeoutMs);

        // If the main controller already aborted (caller cancel or
        // maxDuration fired before this attempt started), abort the
        // attempt immediately so fetch rejects right away.
        if (controller.signal.aborted) {
          attemptController.abort();
        }
        // Propagate a mid-attempt main-controller abort (cancel or
        // maxDuration firing while fetch is in flight) to the attempt
        // controller so fetch rejects promptly. The same wire keeps
        // the stream reader abortable after fetch resolves.
        const mainAbortListener = (): void => {
          attemptController.abort();
        };
        controller.signal.addEventListener('abort', mainAbortListener);
        streamMainAbortListener = mainAbortListener;

        try {
          const res = await httpRequest(url, {
            method: 'POST',
            headers,
            body,
            signal: attemptController.signal,
          });
          if (!res.ok) {
            const message = await extractErrorMessage(res);
            throw await httpErrorFromResponse(res, message);
          }
          return res;
        } catch (error) {
          // If the connect timer fired (and ONLY the connect timer),
          // surface a typed ConnectTimeoutError so defaultRetryOn can
          // retry. When abortReason is 'cancel' or 'maxDuration',
          // rethrow the raw AbortError unchanged.
          if (
            abortReason === 'connect' &&
            error instanceof Error &&
            error.name === 'AbortError'
          ) {
            throw new ConnectTimeoutError(connectTimeoutMs);
          }
          throw error;
        } finally {
          clearTimeout(connectHandle);
          // Do NOT remove the listener here on a successful fetch —
          // it must stay attached so the stream reader remains
          // abortable. On a failed attempt detach now.
          if (
            streamMainAbortListener === mainAbortListener &&
            abortReason !== null
          ) {
            controller.signal.removeEventListener('abort', mainAbortListener);
            streamMainAbortListener = undefined;
          }
        }
      },
      { retryOn },
    );

    // fetch resolved — first byte of the response body is available.
    // Start the inactivity timer. Clear any connect-phase abort tag so
    // a later inactivity fire is not misread as a connect timeout.
    if ((abortReason as AbortReason) === 'connect') {
      abortReason = null;
    }
    resetInactivity();

    if (!response.body) {
      throw new Error(`${logTag} returned no response body.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (cancellationToken?.isCancellationRequested) {
        controller.abort();
        break;
      }

      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      // ADR 0005 — each chunk resets the inactivity timer. This is
      // the core fix: a long-reasoning model that emits a chunk every
      // ~0.5s keeps the stream alive indefinitely; only genuine
      // silence (>inactivityTimeoutMs) fires.
      chunksReceived += 1;
      resetInactivity();

      buffer += decoder.decode(chunk.value, { stream: true });
      // MEDIUM-2 — unbounded stream buffer is a DoS vector. Cap at
      // 1 MiB; if exceeded, abort with an error.
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error(
          `${logTag}: stream buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a newline; aborting to prevent unbounded memory growth.`,
        );
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const stop = options.processLine(line, lineCtx);
        if (stop) {
          done = true;
          break;
        }
      }

      if (done) {
        break;
      }
    }

    if (!done) {
      buffer += decoder.decode();
      if (buffer) {
        for (const line of buffer.split(/\r?\n/)) {
          const stop = options.processLine(line, lineCtx);
          if (stop) {
            done = true;
            break;
          }
        }
      }
    }

    if (!done) {
      if (chunksReceived === 0) {
        // ADR 0005 § No mid-stream retry (Revision 2026-08-03):
        // 200 + headers + no body = server closed before any chunk.
        // 0 chunks = 0 billed tokens. Surface as retryable error, NOT
        // silent onDone — silent empty success masks provider outage.
        callbacks.onError(new ZeroByteSocketCloseError());
        return;
      }
      // Clean stream end without a terminal line from the callback.
      // Run the optional finalizer (compat flushToolCalls) before
      // onDone. If no finalizer, onDone directly.
      if (options.finalize) {
        options.finalize(callbacks);
      } else {
        callbacks.onDone();
      }
    }
  } catch (error) {
    // Route by abortReason. Connect → onError (retry already
    // exhausted inside withRetry). Inactivity → onError (terminal,
    // no retry). MaxDuration → onError (terminal). Cancel → onDone.
    if (error instanceof Error && error.name === 'AbortError') {
      if (abortReason === 'cancel') {
        callbacks.onDone();
        return;
      }
      if (abortReason === 'maxDuration') {
        callbacks.onError(new MaxDurationError(maxDurationMs));
        return;
      }
      if (abortReason === 'inactivity') {
        callbacks.onError(
          new InactivityTimeoutError(inactivityTimeoutMs, chunksReceived),
        );
        return;
      }
      if (abortReason === 'connect') {
        // Connect abort that escaped withRetry (e.g. maxRetries=0).
        callbacks.onError(new ConnectTimeoutError(connectTimeoutMs));
        return;
      }
      // ADR 0005 § No mid-stream retry (Revision 2026-08-03) —
      // bare socket close: AbortError with no abortReason tag.
      if (abortReason === null && chunksReceived === 0) {
        callbacks.onError(new ZeroByteSocketCloseError());
        return;
      }
      if (abortReason === null && chunksReceived > 0) {
        // Bare socket close AFTER chunks were received — terminal.
        callbacks.onError(new ConnectionInterruptedError(chunksReceived));
        return;
      }
      // Ambiguous AbortError with no tag and no chunks — caller-cancel
      // is the safest default.
      callbacks.onDone();
      return;
    }
    // Raw Node socket-close errors (TLS socket closed, ECONNRESET,
    // "aborted at TLSSocket.socketCloseListener", "socket hang up",
    // etc.) are emitted as plain `Error` and escape every AbortError
    // branch above. Reclassify by chunks:
    //   - 0 chunks  → ZeroByteSocketCloseError (retryable, connect-equiv)
    //   - >0 chunks → ConnectionInterruptedError (terminal, mid-stream)
    //
    // CONDITION #4 — typed errors (MidStreamError, HttpError, etc.)
    // pass through here UNCHANGED. `isSocketCloseError` already
    // excludes our own typed errors, so they never match this branch
    // and fall through to the final `callbacks.onError(error)`.
    if (isSocketCloseError(error)) {
      if (chunksReceived === 0) {
        callbacks.onError(new ZeroByteSocketCloseError());
      } else {
        callbacks.onError(new ConnectionInterruptedError(chunksReceived));
      }
      return;
    }
    // Non-abort errors (HttpError, whitelist throw, buffer overrun,
    // ConnectTimeoutError that withRetry gave up on, MidStreamError
    // thrown by the processLine callback) — surface directly.
    callbacks.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    clearTimeout(maxDurationHandle);
    clearInactivity();
    cancelListener?.dispose();
    // Detach any lingering main→attempt abort wire from the last
    // `withRetry` attempt.
    if (streamMainAbortListener) {
      controller.signal.removeEventListener('abort', streamMainAbortListener);
      streamMainAbortListener = undefined;
    }
  }
}

// -------------------------------------------------------------------------
// ADR 0005 — timer resolvers. Formerly duplicated in both clients; now
// centralized here (ADR 0010 module boundary). The deprecation-warning
// flag is module-level (shared, not per-client).
// -------------------------------------------------------------------------

/**
 * Reads, clamps, and resolves the connect timeout. Guards against
 * non-number / NaN / non-positive values (returns the default).
 * Above-maximum values are clamped; below-minimum values are used as-is
 * (tests and power users).
 */
function resolveConnectTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<number>('requestConnectTimeoutMs');
  if (typeof configured !== 'number' || Number.isNaN(configured) || configured <= 0) {
    return REQUEST_CONNECT_TIMEOUT_DEFAULT_MS;
  }
  if (configured > REQUEST_CONNECT_TIMEOUT_MAX_MS) {
    logger.warn(
      `ollamaCloud.requestConnectTimeoutMs=${configured} is above maximum ${REQUEST_CONNECT_TIMEOUT_MAX_MS}; clamping.`,
    );
    return REQUEST_CONNECT_TIMEOUT_MAX_MS;
  }
  return configured;
}

/**
 * Reads, clamps, and resolves the inactivity timeout. Same guarding
 * as `resolveConnectTimeoutMs`.
 */
function resolveInactivityTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<number>('requestInactivityTimeoutMs');
  if (typeof configured !== 'number' || Number.isNaN(configured) || configured <= 0) {
    return REQUEST_INACTIVITY_TIMEOUT_DEFAULT_MS;
  }
  if (configured > REQUEST_INACTIVITY_TIMEOUT_MAX_MS) {
    logger.warn(
      `ollamaCloud.requestInactivityTimeoutMs=${configured} is above maximum ${REQUEST_INACTIVITY_TIMEOUT_MAX_MS}; clamping.`,
    );
    return REQUEST_INACTIVITY_TIMEOUT_MAX_MS;
  }
  return configured;
}

let maxDurationDeprecationWarned = false;

/**
 * Reads, clamps, and resolves the max-duration timeout. Honours the
 * deprecated `ollamaCloud.requestTimeoutMs` alias: if set but
 * `requestMaxDurationMs` is NOT, the legacy value (clamped to its own
 * range) is used. A deprecation warning is logged once per process.
 */
function resolveMaxDurationMs(): number {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const configured = config.get<number>('requestMaxDurationMs');
  if (typeof configured === 'number' && !Number.isNaN(configured) && configured > 0) {
    if (configured > REQUEST_MAX_DURATION_MAX_MS) {
      logger.warn(
        `ollamaCloud.requestMaxDurationMs=${configured} is above maximum ${REQUEST_MAX_DURATION_MAX_MS}; clamping.`,
      );
      return REQUEST_MAX_DURATION_MAX_MS;
    }
    return configured;
  }
  // Deprecated alias: requestTimeoutMs → requestMaxDurationMs.
  const legacy = config.get<number>('requestTimeoutMs');
  if (typeof legacy === 'number' && !Number.isNaN(legacy) && legacy > 0) {
    if (!maxDurationDeprecationWarned) {
      logger.warn(
        'ollamaCloud.requestTimeoutMs is deprecated; use ollamaCloud.requestMaxDurationMs. Mapping requestTimeoutMs → requestMaxDurationMs for backward compatibility.',
      );
      maxDurationDeprecationWarned = true;
    }
    return Math.min(legacy, REQUEST_TIMEOUT_MAX_MS);
  }
  return REQUEST_MAX_DURATION_DEFAULT_MS;
}

/**
 * Extracts the error message from a non-OK HTTP response. Redacts
 * sensitive content (a malicious proxy can reflect the Authorization
 * header in the error body). Formerly duplicated in both clients.
 */
async function extractErrorMessage(response: HttpResponseLike): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    const raw =
      parsed.error?.message || parsed.message || `HTTP ${response.status}`;
    return redactSensitive(raw);
  } catch (error) {
    const preview = body.slice(0, 200);
    logger.warn(
      'Ollama Cloud error response was not valid JSON.',
      preview,
      error,
    );
    if (!body) {
      return `HTTP ${response.status}`;
    }
    return redactSensitive(
      `HTTP ${response.status} (non-JSON body, first 200 chars logged): ${preview}`,
    );
  }
}
