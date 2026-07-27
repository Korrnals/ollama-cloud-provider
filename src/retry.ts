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
 * Connect-phase timeout — `fetch` did not return a `Response` within
 * `requestConnectTimeoutMs`. Retriable by `withRetry`: the wrapper
 * retries the whole `fetch` + status check, which is idempotent at the
 * connect boundary (no stream bytes were produced yet).
 *
 * See ADR 0005 § "Three timers" — connect (30s default, retry).
 */
export class ConnectTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Ollama Cloud: connect timeout after ${timeoutMs}ms`);
    this.name = 'ConnectTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Mid-stream silence — no chunk AND no `: keep-alive` SSE comment for
 * `requestInactivityTimeoutMs` after the first byte arrived. Terminal,
 * NOT retriable: POST `/chat/completions` is not idempotent, retrying
 * bills the user twice (ADR 0001 provider-not-agent, ADR 0005
 * "No mid-stream retry").
 */
export class InactivityTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly chunksReceived: number;

  constructor(timeoutMs: number, chunksReceived: number) {
    super(
      `Ollama Cloud: stream stalled for ${timeoutMs}ms after ${chunksReceived} chunk(s)`,
    );
    this.name = 'InactivityTimeoutError';
    this.timeoutMs = timeoutMs;
    this.chunksReceived = chunksReceived;
  }
}

/**
 * Hard ceiling on total stream duration — `requestMaxDurationMs`
 * elapsed since `streamChat` entry, regardless of chunk activity.
 * Terminal, NOT retriable. Protects the user's token budget from
 * forgotten tabs / crashed callers (owner constraint: «бюджет,
 * недопустимо утекать»).
 *
 * See ADR 0005 § "Three timers" — max-duration (30 min, no retry).
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
 */
export async function httpErrorFromResponse(
  response: Response,
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
 * (`InactivityTimeoutError`, `MaxDurationError`) are terminal —
 * POST `/chat/completions` is not idempotent, retrying mid-stream
 * bills the user twice and shows a duplicate prefix already shown.
 *
 * Retries on:
 * - {@link ConnectTimeoutError} — connect-phase timeout, retryable
 * - {@link HttpError} with status 429 or >= 500
 * - `TypeError` (fetch failed — network error, DNS, connection refused)
 * - `AbortError` (timeout) — note: only meaningful when the abort signal
 *   is per-attempt; if the caller's abort signal is already aborted, the
 *   caller's `retryOn` override should return false to avoid burning
 *   retries on an already-cancelled request.
 *
 * Does NOT retry:
 * - {@link InactivityTimeoutError} — mid-stream silence, terminal
 * - {@link MaxDurationError} — total-duration cap, terminal
 */
export function defaultRetryOn(error: unknown): boolean {
  if (error instanceof ConnectTimeoutError) {
    return true;
  }
  if (error instanceof InactivityTimeoutError) {
    return false;
  }
  if (error instanceof MaxDurationError) {
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
      logger.warn(
        `Retrying after ${delay}ms (attempt ${attemptNumber}/${maxRetries}): ${errorMessage}`,
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