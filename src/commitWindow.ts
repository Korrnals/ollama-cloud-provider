/**
 * ArchCom 2026-09-14 §3.4 — commit-window: the ONLY silent auto-retry
 * boundary for mid-stream interruptions.
 *
 * The first deltas of a stream (`onText` / `onThinking` / `onToolCall`)
 * are buffered for `windowMs` (default 5 s, measured from the FIRST
 * delta event — not from connection start, so slow-TTFT thinking pays
 * no extra latency). While the window is open nothing reaches the
 * caller's callbacks:
 *
 *   - a break inside the window (`ConnectionInterruptedError`) is
 *     retried SILENTLY by `readStream`: the buffer is reset, the user
 *     sees neither a duplicate prefix nor flicker, and the hidden retry
 *     is disclosed only in diagnostics (logger.warn + the runStream
 *     report field);
 *   - the window closes on its timer → the buffer is flushed to the
 *     real callbacks in original order → everything after that streams
 *     directly with NO auto-retry (a mid-stream break after the flush
 *     is a terminal, honest error — manual user retry).
 *
 * This module replaces the former `MID_STREAM_RETRY_MAX_CHUNKS` (50)
 * chunk-count threshold, which was abolished atomically with the
 * window's introduction (ArchCom verdict: removing the threshold alone
 * would silently delete the only working mid-stream retry).
 *
 * ## Placement rationale (why the provider wraps, not the reader)
 *
 * The delta callbacks are INVOKED by the clients' `processLine`
 * closures, which close over the `callbacks` parameter the provider
 * passes into `streamChat` / `streamResponses`. The only interception
 * point that sees every delta is therefore the provider's callbacks
 * object itself. The retry DECISION, however, belongs to `readStream`
 * (it owns the attempt loop and the shared POST budget). The two are
 * bridged by attaching the {@link CommitWindowController} to the
 * wrapped callbacks under the {@link COMMIT_WINDOW_CONTROLLER} symbol;
 * `readStream` discovers it there — no `StreamCallbacks` signature
 * change, no client changes.
 *
 * Honesty clause (Product Architect, ArchCom): the window does NOT
 * heal the long-thinking quiet-gap kill — that is ollama/ollama#16108
 * and client-unfixable. It only removes duplication on early breaks.
 */

import type { StreamCallbacks, ToolCallEvent } from './protocolTypes.js';

/** Default window duration — ArchCom §3.4 "commit-окно ~5 s по времени". */
export const COMMIT_WINDOW_DEFAULT_MS = 5000;

/**
 * Symbol under which the {@link CommitWindowController} rides on the
 * wrapped callbacks object, so `readStream` can discover it without any
 * `StreamCallbacks` interface change (backward compatibility).
 */
export const COMMIT_WINDOW_CONTROLLER: unique symbol = Symbol(
  'ocpCommitWindow',
);

/**
 * The slice of the commit-window state the stream reader needs to drive
 * hidden retries. Returned by {@link createCommitWindow} and attached to
 * the wrapped callbacks.
 */
export interface CommitWindowController {
  /**
   * `true` while NOTHING from the current attempt has been flushed to
   * the user (window not yet closed). A `ConnectionInterruptedError`
   * caught while the window is open is eligible for a silent retry;
   * after the flush it is terminal.
   */
  isOpen(): boolean;
  /**
   * Called by `readStream` before a hidden retry: discards the buffered
   * deltas, re-arms the window for the next attempt (the timer restarts
   * on that attempt's first delta), and increments the diagnostics
   * hidden-retry counter.
   */
  onHiddenRetry(): void;
  /**
   * Number of hidden (silent) retries SCHEDULED so far — diagnostics
   * field. P3-4b honesty note: a retry whose backoff was cancelled by
   * the caller still counts (it was scheduled, its POST was never
   * issued); the cancel-branch log line in `streamReader.ts` states
   * this explicitly so the number is never misread as "POSTs issued".
   */
  hiddenRetryCount(): number;
  /**
   * Flushes the buffer to the real callbacks immediately (idempotent).
   * Called on `onDone` / `onError` and by the provider before rejecting
   * with a thrown terminal error — tokens that were received and billed
   * must not vanish silently.
   */
  flush(): void;
}

/** A `StreamCallbacks` object carrying an attached window controller. */
export type CommitWindowedCallbacks = StreamCallbacks & {
  [COMMIT_WINDOW_CONTROLLER]?: CommitWindowController;
};

/** One buffered delta event, replayed in order on flush. */
type BufferedDelta =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; toolCall: ToolCallEvent };

/** The commit-window handle returned by {@link createCommitWindow}. */
export interface CommitWindow {
  /**
   * Wraps the caller's callbacks: delta callbacks are buffered while
   * the window is open; `onDone` / `onError` flush first; `onUsage` /
   * `onNotice` pass straight through (usage is pure diagnostics, a
   * notice is by definition something the user must see NOW).
   */
  wrap(callbacks: StreamCallbacks): StreamCallbacks;
  /** The controller discovered by `readStream` via the symbol. */
  controller: CommitWindowController;
}

/**
 * Creates a commit-window. `windowMs` exists primarily as the test seam
 * (tests pass tens of milliseconds instead of waiting real seconds);
 * production callers use the {@link COMMIT_WINDOW_DEFAULT_MS} default.
 * Non-positive or non-finite values clamp to 0 — the window degrades to
 * immediate flush, never to an unbuffered/undefined state.
 */
export function createCommitWindow(
  windowMs: number = COMMIT_WINDOW_DEFAULT_MS,
): CommitWindow {
  const safeWindowMs =
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;

  type WindowState = 'idle' | 'buffering' | 'flushed';
  let state: WindowState = 'idle';
  let buffer: BufferedDelta[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hiddenRetries = 0;
  // Set by wrap(); the module is unusable before it, but constructing
  // the controller first keeps a single closure state.
  let inner: StreamCallbacks | undefined;

  const deliver = (delta: BufferedDelta): void => {
    if (!inner) {
      return;
    }
    if (delta.kind === 'text') {
      inner.onText(delta.text);
    } else if (delta.kind === 'thinking') {
      inner.onThinking?.(delta.text);
    } else {
      inner.onToolCall(delta.toolCall);
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = (): void => {
    if (state === 'flushed') {
      return;
    }
    clearTimer();
    const replay = buffer;
    buffer = [];
    state = 'flushed';
    for (const delta of replay) {
      deliver(delta);
    }
  };

  const handleDelta = (delta: BufferedDelta): void => {
    if (state === 'flushed') {
      deliver(delta);
      return;
    }
    buffer.push(delta);
    if (state === 'idle') {
      // The window is armed by the FIRST delta event, not by stream
      // start — a 60 s thinking pause before the first token adds zero
      // extra invisible time.
      state = 'buffering';
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, safeWindowMs);
    }
  };

  const controller: CommitWindowController = {
    isOpen: () => state !== 'flushed',
    onHiddenRetry: () => {
      clearTimer();
      buffer = [];
      state = 'idle';
      hiddenRetries += 1;
    },
    hiddenRetryCount: () => hiddenRetries,
    flush,
  };

  return {
    controller,
    wrap(callbacks: StreamCallbacks): StreamCallbacks {
      inner = callbacks;
      const wrapped: CommitWindowedCallbacks = {
        onText: (text: string) => {
          handleDelta({ kind: 'text', text });
        },
        onToolCall: (toolCall: ToolCallEvent) => {
          handleDelta({ kind: 'toolCall', toolCall });
        },
        onThinking: (text: string) => {
          handleDelta({ kind: 'thinking', text });
        },
        onUsage: (usage) => {
          // Pure diagnostics (token EMA + audit log) — never buffered.
          // P3-4c: a usage from an attempt that a hidden retry then
          // discards would pass straight through and be counted by the
          // EMA twice — unreachable in practice, because `usage` rides
          // the terminal chunk and a broken attempt never receives it.
          callbacks.onUsage?.(usage);
        },
        onDone: () => {
          // A stream can complete while the window is still open (short
          // tool-call responses) — the buffered deltas must still reach
          // the user, exactly once, before termination.
          flush();
          callbacks.onDone();
        },
        onError: (error: Error) => {
          // Tokens that arrived (and were billed) before a terminal
          // error are shown rather than discarded — honesty over
          // prettiness.
          flush();
          callbacks.onError(error);
        },
        onNotice: (text: string) => {
          // Visible by definition (zero-byte extra attempt) — must not
          // wait behind the buffer.
          callbacks.onNotice?.(text);
        },
      };
      wrapped[COMMIT_WINDOW_CONTROLLER] = controller;
      return wrapped;
    },
  };
}
