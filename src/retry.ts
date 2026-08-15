import * as vscode from 'vscode';
import { logger } from './logger.js';

/**
 * Issue 13 — retry wrapper with exponential backoff.
 *
 * Without retry logic, a transient 429 (rate limit) or 5xx
 * (server error) failed the request immediately, even though Ollama
 * Cloud may recover in seconds. This module provides a reusable
 * `withRetry` wrapper usable by any HTTP-emitting call site.
 *
 * IMPORTANT: do NOT wrap SSE streaming in retry — streaming is
 * long-lived, retrying mid-stream is wrong. Only wrap the initial
 * connection (the `fetch` call that establishes the Response). Once
 * the Response is established and streaming begins, surface stream
 * errors to the caller. See `ollamaClient.streamChat` for the pattern.
 */

export interface RetryOptions {
  /** Maximum retry attempts. Default: `ollamaCloud.maxRetries` config (3). */
  maxRetries?: number;
  /** Base delay for the first retry. Default: 1000ms. */
  baseDelayMs?: number;
  /** Upper bound on delay between retries. Default: 30000ms. */
  maxDelayMs?: number;
  /** Predicate deciding whether an error is retriable. */
  retryOn?: (error: unknown) => boolean;
}

/**
 * Error carrying the HTTP status code and optional `Retry-After` delay.
 * Throw this from inside a `withRetry` callback when `fetch` returns a
 * non-OK response, so the retry wrapper can inspect the status and
 * respect the `Retry-After` header.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Mid-stream error — the server sent an error event or a non-OK status
 * surfaced after the response stream had already begun. Terminal, NOT
 * retriable: POST `/chat/completions` is not idempotent, retrying bills
 * the user twice (ADR 0001 provider-not-agent, ADR 0005
 * "No mid-stream retry"). Carries the raw server-provided message so
 * callers can surface it to the user without exposing internal framing.
 */
export class MidStreamError extends Error {
  readonly serverMessage: string;

  constructor(serverMessage: string) {
    super(serverMessage);
    this.name = 'MidStreamError';
    this.serverMessage = serverMessage;
  }
}

/**
 * Zero-byte socket close — the stream returned HTTP 200 + headers but
 * the socket closed before any SSE/ndjson chunk arrived. Retriable by
 * `withRetry`: zero chunks means zero billed tokens (Ollama Cloud bills
 * via the `usage` field emitted inside chunks), so the non-idempotency
 * argument that blocks mid-stream retry does not apply. See ADR 0005
 * § "No mid-stream retry" (Revision 2026-08-03).
 */
export class ZeroByteSocketCloseError extends Error {
  constructor() {
    super('Ollama Cloud: stream closed before any chunk arrived');
    this.name = 'ZeroByteSocketCloseError';
  }
}

/**
 * Mid-stream connection interrupted — the TLS socket closed after one
 * or more chunks had already been received. Terminal, NOT retriable:
 * POST `/chat/completions` is not idempotent and tokens were already
 * billed (ADR 0005 "No mid-stream retry"). Distinct from
 * {@link ZeroByteSocketCloseError} (0 chunks, retryable).
 *
 * This class closes the ADR 0008 Phase 2 priority-level-4 gap: a raw
 * Node socket-close Error (e.g. `aborted at TLSSocket.socketCloseListener`)
 * that arrives AFTER the stream started used to surface to the user as a
 * raw stack trace. The streaming clients translate it into this typed
 * error so `classifyStreamError` can show a clean message.
 */
export class ConnectionInterruptedError extends Error {
  readonly chunksReceived: number;

  constructor(chunksReceived: number) {
    if (chunksReceived <= 0) {
      throw new RangeError(
        'ConnectionInterruptedError requires chunksReceived > 0; use ZeroByteSocketCloseError for the 0-chunk case',
      );
    }
    super(
      `Ollama Cloud: connection interrupted after ${chunksReceived} chunk(s)`,
    );
    this.name = 'ConnectionInterruptedError';
    this.chunksReceived = chunksReceived;
  }
}

/**
 * Detects a raw Node socket-close / network-reset error that escaped
 * the streaming clients' AbortError routing. Node's HTTP client emits
 * these as plain `Error` objects (name = 'Error', NOT 'AbortError')
 * when the underlying TLS socket closes prematurely — e.g.:
 *
 *   - `aborted at TLSSocket.socketCloseListener (node:_http_client:...)`
 *   - `socket hang up`
 *   - `read ECONNRESET` / `write EPIPE`
 *   - `connect ECONNREFUSED`
 *
 * These errors reach the clients' outer catch as plain `Error` and fall
 * through every `error.name === 'AbortError'` branch, surfacing to the
 * user as a raw stack trace (the ADR 0008 Phase 2 level-4 gap). This
 * predicate lets the clients translate them into
 * {@link ZeroByteSocketCloseError} (0 chunks, retryable) or
 * {@link ConnectionInterruptedError} (>0 chunks, terminal).
 *
 * Detection is conservative: it matches on message substrings and the
 * `code` property that Node attaches to system errors. A typed error
 * from our own code (HttpError, MidStreamError, etc.) never matches —
 * those carry their own name and message.
 *
 * @param error  Any caught value.
 * @returns `true` when the error looks like a raw Node socket/network
 *          close that should be reclassified.
 */
export function isSocketCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Our own typed errors are already classified — never reclassify.
  if (
    error instanceof HttpError ||
    error instanceof ZeroByteSocketCloseError ||
    error instanceof ConnectionInterruptedError ||
    error instanceof MaxDurationError ||
    error instanceof MidStreamError
  ) {
    return false;
  }
  // Node system-error `code` (libuv): the socket layer closed abruptly.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (SOCKET_CLOSE_CODES.has(code)) {
      return true;
    }
    // ArchCom 0011c (PA finding — DNS/TLS raw stack traces): DNS
    // failure (ENOTFOUND) and TLS errors are network-layer failures
    // that should be classified (clean user message via
    // classifyStreamError's isSocketCloseError branch) rather than
    // surfaced as raw stack traces. They are PERMANENT — not retried
    // (defaultRetryOn only retries isSocketCloseError at the connect
    // phase for transient codes; ENOTFOUND/TLS classified here still
    // reach retry, but typically only at connect where retry is safe).
    // TLS error codes: DNS (ENOTFOUND) is already covered by
    // SOCKET_CLOSE_CODES above. The remaining TLS errors come in
    // several prefixes from Node's `tls` and OpenSSL layers; some
    // OpenSSL cert-verification reason codes (e.g.
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE) share no common prefix, so they
    // are listed explicitly.
    if (
      code.startsWith('CERT_') ||
      code.startsWith('ERR_TLS_') ||
      code.startsWith('ERR_SSL_') ||
      code.startsWith('DEPTH_ZERO_') ||
      TLS_CERT_VERIFY_CODES.has(code)
    ) {
      return true;
    }
  }
  const message = error.message ?? '';
  // Message-substring detection for the Node HTTP client's own abort
  // framing (no `code` attached). `aborted` is the literal Node emits
  // from `socketCloseListener`; `socket hang up` is undici's framing.
  return (
    message === 'aborted' ||
    message === 'aborted.' ||
    message.startsWith('aborted ') ||
    message.startsWith('socket hang up') ||
    SOCKET_CLOSE_MESSAGE_RE.test(message)
  );
}

/**
 * libuv `code` values that indicate a socket-level close/reset. Sourced
 * from the Node.js + libuv error catalogue (uv_errno_map).
 */
const SOCKET_CLOSE_CODES = new Set([
  'ECONNRESET', // TCP connection reset by peer
  'ECONNREFUSED', // connection refused (server down / port closed)
  'EPIPE', // broken pipe (write after remote close)
  'EHOSTUNREACH', // host unreachable (network layer)
  'ENETUNREACH', // network unreachable
  'ETIMEDOUT', // connect/operation timed out at the socket layer
  'EAI_AGAIN', // DNS temporary failure
  // ArchCom 0011c (PA finding — DNS raw stack traces): ENOTFOUND is a
  // DNS resolution failure (hostname does not resolve). Permanent, not
  // transient — but it IS a network-layer error that should reach the
  // isSocketCloseError branch in classifyStreamError for a clean user
  // message instead of a raw stack trace.
  'ENOTFOUND',
]);

/**
 * OpenSSL TLS certificate-verification reason codes that share no
 * common prefix with the `CERT_*` / `ERR_TLS_*` / `ERR_SSL_*` /
 * `DEPTH_ZERO_*` families. ArchCom 0011c — these surface as raw stack
 * traces to the user unless classified here. Sourced from Node's `tls`
 * layer (which surfaces the OpenSSL verify result as the error `code`).
 */
const TLS_CERT_VERIFY_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', // incomplete cert chain / untrusted intermediate
  'UNABLE_TO_GET_ISSUER_CERT', // issuer cert not found
  'CERT_SIGNATURE_FAILURE', // invalid cert signature
  'CRL_HAS_EXPIRED', // certificate revocation list expired
  'CRL_SIGNATURE_FAILURE', // CRL signature invalid
]);

/**
 * Message-substring detection for socket-close framing Node attaches to
 * the `message` (not `code`). Matches the libuv error description tail
 * and the Node HTTP client abort framing. Anchored on the codes list so
 * a coincidental `ECONNRESET` substring inside an unrelated message
 * still needs the libuv framing (`read `, `write `, `connect `).
 */
const SOCKET_CLOSE_MESSAGE_RE =
  /\b(read|write|connect) (ECONNRESET|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b/;

/**
 * Hard ceiling on total stream duration — `requestMaxDurationMin`
 * (configured in minutes, converted to ms internally) elapsed since
 * `streamChat` entry, regardless of chunk activity.
 * Terminal, NOT retriable. Protects the user's token budget from
 * forgotten tabs / crashed callers (owner constraint: «бюджет,
 * недопустимо утекать»).
 *
 * See ADR 0005 § "Three timers" — max-duration (default 60 min, no retry).
 */
export class MaxDurationError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Ollama Cloud: exceeded max stream duration (${timeoutMs}ms)`);
    this.name = 'MaxDurationError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Builds an {@link HttpError} from a `fetch` Response, parsing the
 * `Retry-After` header (supports both delta-seconds and HTTP-date forms).
 * The response body should already be consumed by the caller (the
 * `message` parameter carries the extracted error text).
 *
 * The `response` param is typed as a minimal structural subset
 * (`{ status; headers: { get(name): string | null } }`) so both the
 * native `HttpResponse` from `httpClient.ts` and a real `fetch()`
 * `Response` are assignable without overlap-mismatch errors. This is
 * the seam introduced by the proxy-aware HTTP client fix.
 */
export async function httpErrorFromResponse(
  response: { status: number; headers: { get(name: string): string | null } },
  message: string,
): Promise<HttpError> {
  let retryAfterMs: number | undefined;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) {
      retryAfterMs = seconds * 1000;
    } else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        retryAfterMs = Math.max(0, date - Date.now());
      }
    }
  }
  return new HttpError(response.status, message, retryAfterMs);
}

/**
 * Returns true for HTTP statuses that are worth retrying: 429 (rate
 * limit) and 5xx (server errors). All other 4xx are permanent for the
 * given request payload and must NOT be retried.
 */
export function isRetriableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Default retriable-error predicate.
 *
 * Retry is **connect-phase only** (ADR 0005). Stream errors
 * (`MaxDurationError`) are terminal — POST `/chat/completions` is not
 * idempotent, retrying mid-stream bills the user twice and shows a
 * duplicate prefix already shown.
 *
 * Retries on:
 * - {@link ZeroByteSocketCloseError} — 0-byte socket close, retryable
 * - {@link HttpError} with status 429 or >= 500
 * - `TypeError` (fetch failed — network error, DNS, connection refused)
 * - `AbortError` (timeout) — note: only meaningful when the abort signal
 *   is per-attempt; if the caller's abort signal is already aborted, the
 *   caller's `retryOn` override should return false to avoid burning
 *   retries on an already-cancelled request.
 * - raw Node socket-close errors (detected via {@link isSocketCloseError})
 *   when caught at the connect phase (inside `withRetry`). Mid-stream
 *   socket closes are reclassified to {@link ConnectionInterruptedError}
 *   by the streaming clients BEFORE reaching retry, so they are terminal.
 *
 * Does NOT retry:
 * - {@link MidStreamError} — server-sent mid-stream error, terminal
 * - {@link ConnectionInterruptedError} — mid-stream socket close, terminal
 * - {@link MaxDurationError} — total-duration cap, terminal
 */
export function defaultRetryOn(error: unknown): boolean {
  if (error instanceof ZeroByteSocketCloseError) {
    return true;
  }
  if (error instanceof ConnectionInterruptedError) {
    return false;
  }
  if (error instanceof MaxDurationError) {
    return false;
  }
  if (error instanceof MidStreamError) {
    return false;
  }
  if (error instanceof HttpError) {
    return isRetriableHttpStatus(error.status);
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return true;
    }
    if (error instanceof TypeError) {
      return true;
    }
    // Raw Node socket-close error (TLS socket closed, ECONNRESET, etc.)
    // caught at the connect phase. Retryable: at the connect boundary no
    // stream bytes were produced, so the non-idempotency argument does
    // not apply. Mirrors `ZeroByteSocketCloseError` (ADR 0008 Phase 3).
    // Mid-stream socket closes are reclassified to
    // `ConnectionInterruptedError` by the streaming clients before they
    // can reach this path.
    if (isSocketCloseError(error)) {
      return true;
    }
  }
  return false;
}

/**
 * Executes `fn` with exponential backoff retry.
 *
 * Delay formula: `min(baseDelayMs * 2^attempt + jitter, maxDelayMs)`
 * where jitter is `Math.random() * 500`. If the error is an
 * {@link HttpError} with a `retryAfterMs` value (from `Retry-After`),
 * that delay is used instead (still clamped to `maxDelayMs`).
 *
 * On final failure, throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const maxRetries =
    options?.maxRetries ?? config.get<number>('maxRetries') ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30000;
  const retryOn = options?.retryOn ?? defaultRetryOn;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !retryOn(error)) {
        throw error;
      }

      const delay = computeDelay(error, attempt, baseDelayMs, maxDelayMs);
      const attemptNumber = attempt + 1;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Issue #41 — Strand 1: structured retry log with the error
      // class so the audit can correlate stream errors (logged in
      // `provider.ts runStream` as `class=...`) with the retry that
      // followed them. `HttpError` adds the status; other retriable
      // errors (AbortError) add only the class.
      const errorClass = error instanceof Error ? error.constructor.name : 'unknown';
      const statusSuffix =
        error instanceof HttpError ? ` status=${error.status}` : '';
      logger.warn(
        `Retrying after ${delay}ms (attempt ${attemptNumber}/${maxRetries}) class=${errorClass}${statusSuffix}: ${errorMessage}`,
      );

      await sleep(delay);
    }
  }

  // Unreachable — the loop either returns or throws. Satisfies the
  // compiler's control-flow analysis for the `Promise<T>` return type.
  throw lastError;
}

function computeDelay(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (error instanceof HttpError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, maxDelayMs);
  }
  const jitter = Math.random() * 500;
  const computed = baseDelayMs * Math.pow(2, attempt) + jitter;
  return Math.min(computed, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
