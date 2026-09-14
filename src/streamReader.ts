/**
 * ADR 0010 — shared streaming lifecycle for Ollama Cloud clients.
 *
 * CONDITION #7 — this is NOT a generic SSE reader. This module is
 * tightly coupled to `retry.ts` and its error classes
 * (`MidStreamError`, `ZeroByteSocketCloseError`,
 * `ConnectionInterruptedError`, `MaxDurationError`). Those classes
 * encode Ollama Cloud's
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
 *   - Single max-duration timer (ADR 0012 revised — connect + inactivity removed)
 *   - `withRetry` connect wrapper + per-attempt AbortController
 *   - Reader loop + 1 MiB buffer cap
 *   - `chunksReceived` accounting + 0-chunk / >0-chunk boundary
 *   - Socket-close reclassification (ADR 0008)
 *   - AbortError routing by `abortReason`
 *   - Commit-window retry loop (ArchCom §3.4): silent in-window retries,
 *     terminal CIE after the window, zero-byte extra visible attempt —
 *     the window STATE lives in `commitWindow.ts` (provider-owned), the
 *     retry DECISION and the shared POST budget live here
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
import {
  COMMIT_WINDOW_CONTROLLER,
  type CommitWindowController,
  type CommitWindowedCallbacks,
} from './commitWindow.js';
import { httpRequest, type HttpResponseLike } from './httpClient.js';
import { logger, redactSensitive } from './logger.js';
import type { StreamCallbacks } from './protocolTypes.js';
import {
  ConnectionInterruptedError,
  MaxDurationError,
  PostBudgetExhaustedError,
  UpstreamIdleTimeoutError,
  ZeroByteSocketCloseError,
  defaultRetryOn,
  httpErrorFromResponse,
  isSocketCloseError,
  withRetry,
} from './retry.js';

// ArchCom 2026-09-14 §3.4 (commit-window, 0.15.x) — the 50-chunk
// `MID_STREAM_RETRY_MAX_CHUNKS` threshold is ABOLISHED. The only silent
// mid-stream auto-retry boundary is now TIME-based: a
// `ConnectionInterruptedError` is retried silently while the
// commit-window is open (first ~5 s of deltas, nothing flushed to the
// user yet — the provider attaches the window controller to the
// callbacks, see `src/commitWindow.ts`). After the window closes, CIE
// is terminal everywhere: an honest error + manual user retry, because
// a retry after visible output would duplicate already-shown text.
//
// Hidden (in-window) retries share the per-message POST budget
// (MAX_POST_BUDGET_PER_MESSAGE) — the budget, not a fixed attempt
// count, is the cap. Backoff keeps the ArchCom train-A jitter rule
// (base * 2^retry * uniform(0.75..1.25)), capped so a flapping server
// cannot stack exponentially longer invisible waits inside one budget.
const COMMIT_WINDOW_RETRY_BASE_DELAY_MS = 1000;
const COMMIT_WINDOW_RETRY_MAX_DELAY_MS = 10_000;

// ArchCom 2026-09-14 (train A) — idle-kill classification. The known
// Ollama Cloud issue ollama/ollama#16108 drops streams after
// ~120-145s of upstream silence (long thinking / tool-argument
// composition). A socket close whose preceding quiet gap reached this
// threshold is classified as a deterministic idle kill — terminal, no
// auto-retry (identical POST → identical silence → identical fail;
// each retry would burn a fresh 60-70s TTFT and possible billing).
// 90s sits safely below the ~120s observed proxy cut so genuine idle
// kills are caught while transient resets stay retryable. Code
// constant, NOT user config — tuned via diagnostics only.
export const IDLE_KILL_QUIET_GAP_MS = 90_000;

// ArchCom 2026-09-14 (train A) — shared POST budget per user message.
// The nested retry structure (mid-stream attempts × connect-phase
// withRetry) could multiply to 12 POSTs worst case; one shared counter
// caps the total at 6 regardless of which layer consumes it.
export const MAX_POST_BUDGET_PER_MESSAGE = 6;

/**
 * ArchCom 2026-09-14 (train A) — pure classifier for the idle-kill
 * signature. Exported for unit testing (no clock mocking needed:
// pass `nowMs` explicitly).
 *
 * For `chunks > 0` the quiet gap is measured from the last received
 * network chunk; for `chunks === 0` it is measured from the moment
 * response headers arrived (the model is thinking and has not emitted
 * a byte yet). Returns an `UpstreamIdleTimeoutError` when the gap
 * reached `IDLE_KILL_QUIET_GAP_MS`, `undefined` otherwise.
 */
export function classifyIdleKill(
  chunks: number,
  lastChunkAt: number | undefined,
  headersAt: number | undefined,
  nowMs: number = Date.now(),
): UpstreamIdleTimeoutError | undefined {
  const anchor = chunks > 0 ? lastChunkAt : headersAt;
  if (anchor === undefined) {
    return undefined;
  }
  const quietMs = nowMs - anchor;
  if (quietMs >= IDLE_KILL_QUIET_GAP_MS) {
    return new UpstreamIdleTimeoutError(quietMs, chunks);
  }
  return undefined;
}

// -------------------------------------------------------------------------
// ADR 0012 (revised) — single-timer architecture. The connect timer
// (60s default) and the inactivity timer were removed: production
// debug logs (2026-08-12) proved the connect timer killed legitimate
// reasoning-model requests with slow TTFT (60–70s), aborting working
// streams and triggering the "extension disconnects / agent loops"
// retry loop. Only max-duration (60 min) remains as the single hard
// ceiling — protects the user's token budget from forgotten tabs and
// crashed callers without cutting off slow-but-alive reasoning.
// -------------------------------------------------------------------------
const REQUEST_MAX_DURATION_MAX_MIN = 1440;
const REQUEST_MAX_DURATION_DEFAULT_MIN = 60;
const MS_PER_MINUTE = 60000;

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
 * the `resetInactivity` function (no-op since ArchCom 0011c) and
 * `markParsed` for the empty-response detection: the callback calls
 * `markParsed()` when it successfully parses a meaningful chunk (data
 * line, event, etc.), so the module can distinguish "bytes arrived but
 * none were valid" (e.g. HTML captive portal at 200) from a real
 * successful stream.
 */
export interface StreamLineContext {
  resetInactivity: () => void;
  markParsed: () => void;
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
  cancellationToken?: CancellationToken;
  /** Line-processing callback — the endpoint-specific parser. */
  processLine: StreamLineProcessor;
  /** Optional finalizer for clean stream-end (compat flushToolCalls). */
  finalize?: StreamFinalizer;
  /**
   * Optional SSRF guard (v0.12.0, ADR 0012). When set, the guard's
   * `assertUrlAllowed(url)` runs inside `withRetry` BEFORE every
   * fetch attempt — right after the whitelist check passes and right
   * before the TCP connect. A blocked URL throws `SsrfBlockedError`,
   * which is terminal (retrying the same URL hits the same IP).
   *
   * The guard is injected (not imported) so tests can pass a fake
   * without stubbing `node:dns`. Clients pass `undefined` to disable
   * SSRF protection (e.g. unit tests that do not exercise the network
   * path); production clients wire `createProductionSsrfGuard()`.
   */
  ssrfGuard?: { assertUrlAllowed(url: string): Promise<void> };
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
/**
 * Commit-window retry wrapper around `readStreamOnce` (ArchCom
 * 2026-09-14 §3.4, replaces the former 50-chunk threshold loop).
 *
 * Retry policy — the ONLY silent auto-retry boundary is the
 * commit-window (time-based, `src/commitWindow.ts`):
 *
 *   - `ConnectionInterruptedError` while the window is open (nothing
 *     flushed to the user) → SILENT retry: buffer reset via the window
 *     controller, jittered backoff, hidden-retry counter surfaced in
 *     diagnostics only (logger.warn + the runStream report field). No
 *     `onNotice` — the user must not see a duplicate prefix or flicker.
 *   - `ConnectionInterruptedError` after the window closed → TERMINAL.
 *     Honest error, manual user retry. There is no chunk-count
 *     threshold anymore — visibility, not volume, decides.
 *   - `ZeroByteSocketCloseError` thrown out of `withRetry` (connect-
 *     phase retries exhausted, non-idle <90 s close with 0 chunks —
 *     nothing shown by construction) → ONE additional VISIBLE attempt
 *     announced via `onNotice`, then terminal (ArchCom design
 *     condition). Connect-phase ZeroByte retries inside `withRetry`
 *     stay silent as before — that is not mid-stream.
 *
 * All hidden retries draw from the shared POST budget
 * (`MAX_POST_BUDGET_PER_MESSAGE`); the loop terminates because every
 * attempt consumes at least one budget unit before it can fail with a
 * retryable class.
 *
 * Every other error (MidStreamError, HttpError, MaxDurationError,
 * UpstreamIdleTimeoutError, PostBudgetExhaustedError, cancel, buffer
 * overrun) passes through unchanged — terminal by classification.
 */
export async function readStream(
  options: StreamReaderOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  // ArchCom 2026-09-14 (train A) — one shared POST budget across the
  // commit-window retries below AND the connect-phase withRetry inside
  // each attempt. Caps the worst case at 6 POSTs per user message.
  const budget = { remaining: MAX_POST_BUDGET_PER_MESSAGE };
  const commitWindow = getAttachedCommitWindow(callbacks);
  let zeroByteExtraAttemptUsed = false;
  let hiddenRetryCount = 0;
  // Each attempt consumes ≥1 budget unit, so the loop is finite.
  for (;;) {
    // Track chunks received THIS attempt — readStreamOnce updates
    // a local copy; we read it via a shared object.
    const attemptState = { chunksReceived: 0 };
    try {
      await readStreamOnce(options, callbacks, attemptState, budget);
      return; // success
    } catch (error) {
      const cancelled =
        options.cancellationToken?.isCancellationRequested === true;

      if (error instanceof ConnectionInterruptedError) {
        // Window open ⇔ nothing from this attempt reached the user.
        // No window attached (plain callers/tests) ⇒ terminal: without
        // a visibility owner there is no silent-retry boundary.
        const windowOpen = commitWindow !== undefined && commitWindow.isOpen();
        logger.warn(
          `Mid-stream retry eval: chunks=${attemptState.chunksReceived} windowOpen=${windowOpen} hiddenRetry=${hiddenRetryCount} budgetRemaining=${budget.remaining} cancelled=${cancelled} errorClass=${error.constructor.name}`,
        );
        if (!windowOpen || cancelled || budget.remaining <= 0) {
          throw error;
        }
        hiddenRetryCount += 1;
        // Reset the buffer BEFORE the retry so the discarded attempt's
        // deltas can never leak into the user-visible stream.
        commitWindow.onHiddenRetry();
        // Exponential backoff: 1s, 2s, 4s... capped, with ±25% jitter
        // (ArchCom 2026-09-14, Security condition): a systemic cloud
        // incident would otherwise synchronize retries across requests.
        const jitter = 0.75 + Math.random() * 0.5;
        const delay = Math.round(
          Math.min(
            COMMIT_WINDOW_RETRY_BASE_DELAY_MS *
              Math.pow(2, hiddenRetryCount - 1) *
              jitter,
            COMMIT_WINDOW_RETRY_MAX_DELAY_MS,
          ),
        );
        logger.warn(
          `Commit-window hidden retry ${hiddenRetryCount}: ConnectionInterruptedError after ${attemptState.chunksReceived} chunks inside the window — buffer reset, user sees nothing. Retrying in ${delay}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (error instanceof ZeroByteSocketCloseError) {
        // Thrown out of `withRetry` ⇒ connect-phase retries exhausted
        // (or maxRetries=0). 0 chunks ⇒ nothing was shown — the ArchCom
        // §3.4 design condition grants ONE additional VISIBLE attempt,
        // then terminal. No extra backoff: withRetry just ran its full
        // exponential schedule; the visible notice explains the wait.
        if (zeroByteExtraAttemptUsed || cancelled || budget.remaining <= 0) {
          // Surface through the callback contract (same as the
          // pre-window behaviour), then stop — readStreamOnce already
          // handled socket teardown.
          callbacks.onError(error);
          return;
        }
        zeroByteExtraAttemptUsed = true;
        const notice =
          '\n\n[Ответ так и не начался — делаю последнюю автоматическую попытку]\n\n';
        if (callbacks.onNotice) {
          callbacks.onNotice(notice);
        } else {
          // Doc contract: absent handler → the notice is logged, not
          // dropped (review P3-3г).
          logger.warn(
            `Zero-byte extra attempt notice (no onNotice handler): ${notice.trim()}`,
          );
        }
        logger.warn(
          `Zero-byte close survived connect-phase retries — one extra visible attempt (budgetRemaining=${budget.remaining}).`,
        );
        continue;
      }

      throw error;
    }
  }
}

/**
 * Discovers the commit-window controller the provider attached to the
 * (wrapped) callbacks object. Plain callbacks — no window — return
 * `undefined`, which means "no silent mid-stream retry boundary".
 */
function getAttachedCommitWindow(
  callbacks: StreamCallbacks,
): CommitWindowController | undefined {
  const controller = (callbacks as CommitWindowedCallbacks)[
    COMMIT_WINDOW_CONTROLLER
  ];
  return controller ?? undefined;
}

/**
 * Single attempt of `readStream`. This is the original `readStream`
 * body, extracted so the retry wrapper can call it multiple times.
 * `attemptState.chunksReceived` is updated so the caller can decide
 * whether to retry.
 */
async function readStreamOnce(
  options: StreamReaderOptions,
  callbacks: StreamCallbacks,
  attemptState: { chunksReceived: number },
  budget: { remaining: number },
): Promise<void> {
  const { logTag, url, headers, body, cancellationToken } = options;

  // ADR 0012 (revised) — single timer (max-duration) replaces the
  // former three-timer architecture. Connect + inactivity timers were
  // removed: the connect timer killed legitimate slow-TTFT reasoning
  // requests. Only max-duration (60 min) remains as the hard ceiling.
  // No mid-stream retry: POST endpoints are not idempotent.
  const controller = new AbortController();
  const maxDurationMs = resolveMaxDurationMs();

  logger.debug(
    `${logTag}: readStream START — maxDuration=${maxDurationMs}ms`,
  );

  // ArchCom 2026-09-14 (train A) — idle-kill tracking. `headersAt` is
  // stamped when the response headers arrive (the probe then waits for
  // the first byte — a 0-chunk thinking pause is measured from here);
  // `lastChunkAt` is stamped per received network chunk. The catch
  // block feeds both into `classifyIdleKill` to detect the
  // ollama/ollama#16108 signature (server/proxy drops the stream
  // after a long silent thinking phase).
  let headersAt: number | undefined;
  let lastChunkAt: number | undefined;
  // Review P2-1 — class name of the most recent failed attempt, so the
  // typed budget-exhausted error can name what the budget was spent on.
  let lastAttemptErrorClass: string | undefined;

  // Tagged abort reason — the catch block routes by this tag to emit
  // the right user-facing message and to decide onDone vs onError.
  type AbortReason = 'maxDuration' | 'cancel' | null;
  let abortReason: AbortReason = null;

  // Max-duration: one setTimeout at start, never reset, cleared in finally.
  const maxDurationHandle = setTimeout(() => {
    abortReason = 'maxDuration';
    logger.error(
      `${logTag}: exceeded max stream duration (${maxDurationMs}ms)`,
    );
    controller.abort();
  }, maxDurationMs);

  // Count of chunks received — condition #3: incremented by this module,
  // NOT by the callback. Used by the catch block to distinguish
  // connect/first-token (0 chunks) from mid-stream (>0 chunks) for
  // error messages. Also tracked in `attemptState` for the retry
  // wrapper to decide whether to retry.
  let chunksReceived = 0;
  const trackChunks = (n: number): void => {
    chunksReceived = n;
    attemptState.chunksReceived = n;
    lastChunkAt = Date.now();
  };
  // ArchCom 0011c (SSE finding #1): track parsed (meaningful) chunks
  // separately from raw bytes received. If bytes arrive but none parse
  // (e.g. HTML captive portal at 200), parsedChunks stays 0 → we surface
  // an error instead of a silent empty success.
  let parsedChunks = 0;

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

  // StreamLineContext passed to processLine. resetInactivity is a
  // no-op stub (inactivity timer removed in ADR 0012 revised); kept on
  // the interface for backward-compat with the callback contract.
  const lineCtx: StreamLineContext = {
    resetInactivity: () => { /* no-op — inactivity timer removed */ },
    markParsed: () => { parsedChunks += 1; },
  };

  try {
    // Issue 13 / ADR 0005 — retry the INITIAL CONNECTION only.
    // `withRetry` wraps just the `fetch` + status check; the body
    // reader loop is outside the wrapper. Stream errors are terminal.
    const retryOn = (error: unknown): boolean => {
      if (cancellationToken?.isCancellationRequested) {
        return false;
      }
      // Do not retry on AbortError — it means caller-cancel or an
      // ambiguous network abort. Default to not retrying.
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
        // ArchCom 2026-09-14 (train A) — shared POST budget. Every
        // connect attempt (including retries inside withRetry)
        // consumes from the same counter the mid-stream loop uses.
        // Exhausted budget fails the attempt without retrying, as a
        // typed error (review P2-1) so classifyStreamError can show an
        // honest localized message naming the cap.
        if (budget.remaining <= 0) {
          throw new PostBudgetExhaustedError(lastAttemptErrorClass);
        }
        budget.remaining -= 1;

        // Detach any previous attempt's main→attempt wire before
        // installing a fresh one.
        if (streamMainAbortListener) {
          controller.signal.removeEventListener('abort', streamMainAbortListener);
          streamMainAbortListener = undefined;
        }

        const attemptController = new AbortController();

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
          // v0.12.0 ADR 0012 — SSRF guard. Runs AFTER the SEC-03
          // string-whitelist check (which already passed in the
          // client) and BEFORE the TCP connect. The window between
          // this check and the actual connect is the smallest a
          // DNS-rebinding attack can exploit. A blocked URL throws
          // `SsrfBlockedError` — terminal (retry hits same IP), so it
          // propagates out of `withRetry` without retry. The guard is
          // optional; clients pass `undefined` to disable (tests,
          // local Ollama connections that opted out).
          if (options.ssrfGuard) {
            await options.ssrfGuard.assertUrlAllowed(url);
          }
          const res = await httpRequest(url, {
            method: 'POST',
            headers,
            body,
            signal: attemptController.signal,
          });
          headersAt = Date.now();
          if (!res.ok) {
            const message = await extractErrorMessage(res);
            throw await httpErrorFromResponse(res, message);
          }
          // ArchCom 0011c Fix 6 — probe the FIRST chunk inside the retry
          // wrapper. ZeroByteSocketCloseError was classified retryable in
          // retry.ts but never actually retried, because the 0-byte close
          // only surfaces AFTER withRetry returns (once the body reader
          // loop runs). Moving one read inside the wrapper turns the
          // post-connect 0-byte close into a connect-phase error that
          // `defaultRetryOn` retries. Safe per ADR 0005: 0 chunks = 0
          // billed tokens, so retry does not double-bill.
          if (!res.body) {
            throw new Error(`${logTag} returned no response body.`);
          }
          const probeReader = res.body.getReader();
          try {
            const first = await probeReader.read();
            if (first.done) {
              // ArchCom 2026-09-14 (train A) — a clean EOF after a long
              // silent thinking pause (headers arrived, no byte since) is
              // the idle-kill signature too (FIN instead of RST). The
              // idle error is terminal — defaultRetryOn returns false —
              // so the probe does NOT burn 3× ~145s retries on a
              // deterministic failure.
              const idleDone = classifyIdleKill(0, undefined, headersAt);
              if (idleDone) {
                throw idleDone;
              }
              // 200 + headers + immediate EOF = server closed before any
              // chunk. Retryable: 0 chunks = 0 billed tokens.
              throw new ZeroByteSocketCloseError();
            }
            // Data arrived — release the lock so the outer loop can
            // re-acquire the reader and continue. Return the first chunk
            // so it is processed, not lost.
            probeReader.releaseLock();
            return { response: res, firstChunk: first.value };
          } catch (error) {
            // Re-classify a raw socket-close during the probe as a
            // retryable ZeroByteSocketCloseError (0 chunks). Our own
            // ZeroByteSocketCloseError (thrown above) passes through.
            if (error instanceof ZeroByteSocketCloseError) {
              throw error;
            }
            // Idle-kill classification for the probe path — the
            // dominant 0-chunk thinking-kill scenario (#16108): headers
            // arrived, the model thinks in silence, the cloud proxy
            // cuts the stream. Terminal, not retried.
            if (error instanceof UpstreamIdleTimeoutError) {
              throw error;
            }
            // Release the lock on a failed probe so the stream tears down.
            try {
              probeReader.releaseLock();
            } catch {
              // Already released or locked elsewhere — ignore.
            }
            if (isSocketCloseError(error)) {
              const idleClose = classifyIdleKill(0, undefined, headersAt);
              if (idleClose) {
                throw idleClose;
              }
              throw new ZeroByteSocketCloseError();
            }
            throw error;
          }
        } catch (error) {
          // ADR 0012 (revised) — connect timer removed. Rethrow all
          // errors unchanged; defaultRetryOn decides retryability.
          lastAttemptErrorClass = (error as Error)?.constructor?.name;
          throw error;
        } finally {
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

    // Fix 6 — withRetry now returns the response PLUS the first chunk
    // it probed (to detect a 0-byte close inside the retry window).
    // Seed the buffer + chunk counter with that first chunk so it is
    // processed by the loop, not lost.
    if (!response.response.body) {
      throw new Error(`${logTag} returned no response body.`);
    }

    const reader = response.response.body.getReader();
    const decoder = new TextDecoder();
    // Fix 6 — the first chunk was already read inside withRetry. Decode
    // it into the buffer and account for it so chunksReceived reflects
    // reality (used by the empty-stream + captive-portal detection
    // below).
    let buffer = decoder.decode(response.firstChunk, { stream: true });
    trackChunks(1); // chunksReceived = 1 (first chunk probed inside withRetry)
    // Fix 6 — the first chunk was probed inside withRetry. Apply the
    // same buffer-cap + line-processing the loop applies to subsequent
    // chunks so a single oversized first chunk is caught and its lines
    // are parsed (not deferred until the post-loop flush).
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error(
        `${logTag}: stream buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a newline; aborting to prevent unbounded memory growth.`,
      );
    }
    {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const stop = options.processLine(line, lineCtx);
        if (stop) {
          done = true;
          break;
        }
      }
    }

    while (true) {
      if (done) {
        break;
      }
      if (cancellationToken?.isCancellationRequested) {
        controller.abort();
        break;
      }

      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      trackChunks(chunksReceived + 1);

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
      // ArchCom 0011c (SSE finding #1): bytes arrived but NONE parsed
      // as meaningful data. Likely HTML captive portal, CDN error page,
      // or proxy interception. Surface as error — do NOT silently
      // return an empty success.
      if (parsedChunks === 0) {
        callbacks.onError(new Error(
          `${logTag}: received ${chunksReceived} chunk(s) of data but none were valid stream events. This may indicate a captive portal, proxy error page, or server misconfiguration.`,
        ));
        return;
      }
      // Review P3-1 (2026-09-14) — a FIN (clean EOF) after a long
      // silent pause is the same #16108 idle-kill as an RST; without
      // this check it passed as a normal stream end and silently
      // truncated the answer. Terminal, surfaced honestly.
      const idleEnd = classifyIdleKill(chunksReceived, lastChunkAt, headersAt);
      if (idleEnd && chunksReceived > 0) {
        logger.warn(
          `${logTag}: idle kill at clean stream end — quiet=${idleEnd.quietMs}ms chunks=${chunksReceived} (ollama/ollama#16108 signature)`,
        );
        callbacks.onError(idleEnd);
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
    // ArchCom 0011c (SSE finding #2 — socket leak): on non-abort
    // errors (MidStreamError, buffer overrun, whitelist throw), the
    // response.body reader is never cancelled, so the socket lingers
    // until the server closes it or max-duration fires (30 min). Abort
    // the controller here to tear down the socket via the existing
    // abort → req.destroy() wire. Idempotent: if already aborted (e.g.
    // inactivity/maxDuration path already ran), this is a no-op. This
    // runs BEFORE the AbortError branch — for errors that ARE already
    // AbortError the abort is a no-op, and the routing decisions below
    // (onError vs onDone) are unchanged.
    controller.abort();
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
      // ADR 0005 § No mid-stream retry (Revision 2026-08-03) —
      // bare socket close: AbortError with no abortReason tag.
      if (abortReason === null && chunksReceived === 0) {
        // ArchCom 2026-09-14 (train A) — idle kill beats the generic
        // 0-chunk classification: a close after a long silent thinking
        // pause is deterministic (#16108), so no retry anywhere.
        const idle = classifyIdleKill(0, lastChunkAt, headersAt);
        if (idle) {
          logger.warn(
            `${logTag}: idle kill detected — quiet=${Date.now() - (headersAt ?? Date.now())}ms chunks=0 (ollama/ollama#16108 signature)`,
          );
          callbacks.onError(idle);
          return;
        }
        callbacks.onError(new ZeroByteSocketCloseError());
        return;
      }
      if (abortReason === null && chunksReceived > 0) {
        // Mid-stream retry: throw instead of callbacks.onError so the
        // retry wrapper in `readStream` can catch and retry. Idle-kill
        // (long silence between chunks) is terminal instead — retrying
        // an identical POST reproduces the same silence.
        const idle = classifyIdleKill(chunksReceived, lastChunkAt, headersAt);
        if (idle) {
          logger.warn(
            `${logTag}: idle kill detected mid-stream — quiet=${idle.quietMs}ms chunks=${chunksReceived} (ollama/ollama#16108 signature)`,
          );
          callbacks.onError(idle);
          return;
        }
        throw new ConnectionInterruptedError(chunksReceived);
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
      // v0.11.0 Task 2 — debug diagnostics for socket-close errors.
      // Distinguishes ECONNRESET (server RST) from EPIPE (write after
      // remote close) from UND_ERR_SOCKET (undici socket hang up) when
      // ollamaCloud.debug is enabled. Matches the error.code access
      // idiom used by isSocketCloseError in retry.ts.
      if (error instanceof Error) {
        const errCode = (error as { code?: unknown }).code;
        logger.debug(
          `${logTag}: socket-close error — code=${typeof errCode === 'string' ? errCode : 'none'} name=${error.name} chunksReceived=${chunksReceived} message=${error.message}`,
        );
      }
      if (chunksReceived === 0) {
        // ArchCom 2026-09-14 (train A) — idle-kill check before the
        // retryable 0-chunk classification (see AbortError branch).
        const idle = classifyIdleKill(0, lastChunkAt, headersAt);
        if (idle) {
          logger.warn(
            `${logTag}: idle kill detected — quiet=${Date.now() - (headersAt ?? Date.now())}ms chunks=0 (ollama/ollama#16108 signature)`,
          );
          callbacks.onError(idle);
          return;
        }
        callbacks.onError(new ZeroByteSocketCloseError());
      } else {
        // ArchCom 2026-09-14 (train A) — long silence before the close
        // means a deterministic idle kill: terminal, not retried.
        const idle = classifyIdleKill(chunksReceived, lastChunkAt, headersAt);
        if (idle) {
          logger.warn(
            `${logTag}: idle kill detected mid-stream — quiet=${idle.quietMs}ms chunks=${chunksReceived} (ollama/ollama#16108 signature)`,
          );
          callbacks.onError(idle);
          return;
        }
        // Mid-stream retry: throw instead of callbacks.onError so the
        // retry wrapper in `readStream` can catch and retry.
        throw new ConnectionInterruptedError(chunksReceived);
      }
      return;
    }
    // ArchCom 2026-09-14 §3.4 — a ZeroByteSocketCloseError reaching this
    // fallthrough means `withRetry` exhausted its connect-phase retries
    // (the probe reclassifies 0-chunk closes inside the wrapper). Throw
    // it instead of surfacing via onError so `readStream` can apply the
    // one-extra-visible-attempt policy; if no attempt is granted it
    // delivers the error through the callback contract itself.
    if (error instanceof ZeroByteSocketCloseError) {
      throw error;
    }
    // Non-abort errors (HttpError, whitelist throw, buffer overrun,
    // MidStreamError thrown by the processLine callback) — surface
    // directly.
    callbacks.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    clearTimeout(maxDurationHandle);
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
 * Reads, clamps, and resolves the max-duration timeout — the single
 * remaining timer (ADR 0012 revised). Connect + inactivity timers were
 * removed; only max-duration (60 min default) survives as the hard
 * ceiling.
 *
 * The user configures the ceiling in MINUTES via
 * `ollamaCloud.requestMaxDurationMin` (package.json enforces integer
 * 1–1440). Internally the timer uses ms, so we multiply by 60000. The
 * code clamp is a secondary defence — a user can still set an
 * out-of-range value via raw JSON.
 */
function resolveMaxDurationMs(): number {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const configuredMin = config.get<number>('requestMaxDurationMin');
  if (
    typeof configuredMin === 'number' &&
    !Number.isNaN(configuredMin) &&
    configuredMin > 0
  ) {
    if (configuredMin > REQUEST_MAX_DURATION_MAX_MIN) {
      logger.warn(
        `ollamaCloud.requestMaxDurationMin=${configuredMin} is above maximum ${REQUEST_MAX_DURATION_MAX_MIN}; clamping.`,
      );
      return REQUEST_MAX_DURATION_MAX_MIN * MS_PER_MINUTE;
    }
    return configuredMin * MS_PER_MINUTE;
  }
  return REQUEST_MAX_DURATION_DEFAULT_MIN * MS_PER_MINUTE;
}

/**
 * Extracts the error message from a non-OK HTTP response. Redacts
 * sensitive content (a malicious proxy can reflect the Authorization
 * header in the error body). Formerly duplicated in both clients.
 */
async function extractErrorMessage(response: HttpResponseLike): Promise<string> {
  const body = await response.text();
  // RCA 2026-08-19 — log the RAW response body on non-200 so we can
  // see EXACTLY what the server says (HTTP 400 with empty body vs
  // "context length exceeded" vs "invalid request" etc).
  if (response.status >= 400) {
    // CR #1 — redact the raw body preview before logging. Server
    // error bodies may echo request headers, query params, or
    // custom secret formats the logger's redaction patterns do
    // not cover. `redactSensitive` is already imported above.
    logger.warn(
      `extractErrorMessage: status=${response.status} rawBodyLen=${body.length} rawBodyPreview=${redactSensitive(body.slice(0, 500))}`,
    );
  }
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
