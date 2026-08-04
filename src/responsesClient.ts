// ADR 0006 — `/v1/responses` streaming client.
//
// Mirrors `ollamaClient.ts` (the `/chat/completions` client) for the
// `/v1/responses` endpoint. Same ADR 0005 three-timer architecture
// (connect / inactivity / maxDuration), same per-attempt
// AbortController fix (v0.5.3), same SEC-03 per-connection whitelist
// gate. Differences from `/chat/completions`:
//
// - URL: `${openAiBaseUrl}/responses` (not `/chat/completions`).
// - Request body: `{ model, input[], instructions?, tools?, stream:true }`
//   (not `messages[]`). Built by `convertResponses.ts`.
// - Stream protocol: SSE `event:` + `data:` two-line pairs. The
//   parser holds a `pendingEvent` string and dispatches on the event
//   type when the `data:` line arrives. There is NO `data: [DONE]`
//   marker — termination is `response.completed`.
// - Tool calls: a single `response.output_item.done` event with
//   `item.type === 'function_call'` carries the full call (no
//   delta-accumulation needed — the endpoint emits the complete
//   arguments string in one event).
import * as vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import {
  assertBaseUrlAllowed,
  assertBaseUrlAllowedForConnection,
} from './configValidator.js';
import type { ConnectionConfig } from './connections.js';
import { openAiBaseUrl } from './connections.js';
import { httpRequest, type HttpResponseLike } from './httpClient.js';
import { logger, redactSensitive } from './logger.js';
import type {
  ResponsesInputItem,
  ResponsesTool,
  ResponsesOutputItem,
  StreamCallbacks,
  UsageInfo,
} from './protocolTypes.js';
import {
  ConnectTimeoutError,
  InactivityTimeoutError,
  MaxDurationError,
  MidStreamError,
  ZeroByteSocketCloseError,
  defaultRetryOn,
  httpErrorFromResponse,
  withRetry,
} from './retry.js';

// ADR 0005 — three timers. Same defaults/maxes as `ollamaClient.ts`;
// the resolver helpers are duplicated here (not shared) because the
// chat client owns its resolver closure and the responses client
// must stay independent per ADR 0006 (no shared mutable state).
// v0.9.0 — connect default raised to 60s (1 min), inactivity default
// raised to 300s (5 min) with a soft/grace extension (see
// resetInactivity). The max stays at 600s (10 min).
const REQUEST_CONNECT_TIMEOUT_MAX_MS = 120000;
const REQUEST_CONNECT_TIMEOUT_DEFAULT_MS = 60000;

const REQUEST_INACTIVITY_TIMEOUT_MAX_MS = 600000;
const REQUEST_INACTIVITY_TIMEOUT_DEFAULT_MS = 300000;
// v0.9.0 — soft threshold: first fire extends to the full grace period
// instead of hard-killing. See ollamaClient.ts for full rationale.
const REQUEST_INACTIVITY_SOFT_THRESHOLD_MS = 120000;

const REQUEST_MAX_DURATION_MAX_MS = 3600000;
const REQUEST_MAX_DURATION_DEFAULT_MS = 1800000;

// MEDIUM-2 — cap the SSE buffer at 1 MiB. Same defence as
// `ollamaClient.ts`: a hostile/malformed stream with no newlines
// would grow the buffer without bound; this cap turns that into a
// bounded, reported error.
const MAX_SSE_BUFFER_BYTES = 1048576;

export class ResponsesClient {
  /**
   * Optional connection the client is bound to. When set, every fetch
   * boundary enforces the connection's own `allowedBaseUrls`
   * whitelist via `assertBaseUrlAllowedForConnection` (the SEC-03
   * per-connection gate). When unset, the legacy global whitelist via
   * `assertBaseUrlAllowed` is enforced — preserving backward
   * compatibility.
   */
  private readonly connection: ConnectionConfig | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    connection?: ConnectionConfig,
  ) {
    this.connection = connection;
  }

  /**
   * Returns the fetch URL for `/v1/responses`. When bound to a
   * connection, uses `openAiBaseUrl(connection) + '/responses'`;
   * otherwise `baseUrl + '/responses'`.
   */
  private responsesUrl(): string {
    if (this.connection) {
      return `${openAiBaseUrl(this.connection)}/responses`;
    }
    return `${this.baseUrl}/responses`;
  }

  /**
   * SEC-03 per-connection whitelist gate. Throws synchronously when
   * the resolved baseUrl is not in the connection's whitelist (or the
   * global whitelist when no connection is bound). The catch block
   * surfaces it to the caller via onError.
   */
  private assertBaseUrlAllowedOrThrow(): void {
    if (this.connection) {
      assertBaseUrlAllowedForConnection(
        openAiBaseUrl(this.connection),
        this.connection,
      );
    } else {
      assertBaseUrlAllowed(this.baseUrl);
    }
  }

  async streamResponses(
    request: {
      model: string;
      input: ResponsesInputItem[];
      instructions?: string;
      tools?: ResponsesTool[];
      tool_choice?: 'auto' | 'required' | 'none';
      extraBody?: Record<string, unknown>;
    },
    callbacks: StreamCallbacks,
    cancellationToken?: CancellationToken,
  ): Promise<void> {
    // ADR 0005 — three timers. Identical structure to
    // `ollamaClient.streamChat`; see that file for the full rationale.
    const controller = new AbortController();
    const connectTimeoutMs = resolveConnectTimeoutMs();
    const inactivityTimeoutMs = resolveInactivityTimeoutMs();
    const maxDurationMs = resolveMaxDurationMs();

    type AbortReason =
      | 'connect'
      | 'inactivity'
      | 'maxDuration'
      | 'cancel'
      | null;
    let abortReason: AbortReason = null;

    const maxDurationHandle = setTimeout(() => {
      abortReason = 'maxDuration';
      logger.error(
        `Ollama Cloud (/v1/responses): exceeded max stream duration (${maxDurationMs}ms)`,
      );
      controller.abort();
    }, maxDurationMs);

    let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
    // v0.9.0 — soft/grace period (see ollamaClient.ts for rationale).
    let inactivitySoftFired = false;
    const resetInactivity = (): void => {
      if (inactivityHandle !== undefined) {
        clearTimeout(inactivityHandle);
      }
      inactivitySoftFired = false;
      // Short-timeout path: when the configured inactivity timeout is
      // at or below the soft threshold, fire HARD directly at the
      // configured duration. No soft extension (see ollamaClient.ts).
      if (inactivityTimeoutMs <= REQUEST_INACTIVITY_SOFT_THRESHOLD_MS) {
        inactivityHandle = setTimeout(() => {
          abortReason = 'inactivity';
          logger.error(
            `Ollama Cloud (/v1/responses): stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
          );
          controller.abort();
        }, inactivityTimeoutMs);
        return;
      }
      // Long-timeout path: soft threshold + grace extension.
      inactivityHandle = setTimeout(() => {
        if (!inactivitySoftFired) {
          inactivitySoftFired = true;
          if (inactivityHandle !== undefined) {
            clearTimeout(inactivityHandle);
          }
          logger.warn(
            `Ollama Cloud (/v1/responses): stream stalled for ${REQUEST_INACTIVITY_SOFT_THRESHOLD_MS}ms — extending to ${inactivityTimeoutMs}ms grace period`,
          );
          inactivityHandle = setTimeout(() => {
            abortReason = 'inactivity';
            logger.error(
              `Ollama Cloud (/v1/responses): stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
            );
            controller.abort();
          }, inactivityTimeoutMs);
          return;
        }
        abortReason = 'inactivity';
        logger.error(
          `Ollama Cloud (/v1/responses): stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
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

    let chunksReceived = 0;

    const cancelListener = cancellationToken?.onCancellationRequested(() => {
      abortReason = 'cancel';
      controller.abort();
    });
    if (cancellationToken?.isCancellationRequested) {
      abortReason = 'cancel';
      controller.abort();
    }

    let done = false;
    let streamMainAbortListener: (() => void) | undefined;

    try {
      this.assertBaseUrlAllowedOrThrow();

      const { extraBody, ...baseRequest } = request;
      const body = JSON.stringify({
        ...baseRequest,
        ...extraBody,
        stream: true,
      });

      // ADR 0005 — retry the INITIAL CONNECTION only. `withRetry`
      // wraps just the `fetch` + status check; the body reader loop
      // is outside the wrapper.
      const retryOn = (error: unknown): boolean => {
        if (cancellationToken?.isCancellationRequested) {
          return false;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          return false;
        }
        return defaultRetryOn(error);
      };

      const response = await withRetry(
        async () => {
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

          if (controller.signal.aborted) {
            attemptController.abort();
          }
          const mainAbortListener = (): void => {
            attemptController.abort();
          };
          controller.signal.addEventListener('abort', mainAbortListener);
          streamMainAbortListener = mainAbortListener;

          try {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
            };
            if (this.apiKey) {
              headers.Authorization = `Bearer ${this.apiKey}`;
            }
            const res = await httpRequest(this.responsesUrl(), {
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

      if ((abortReason as AbortReason) === 'connect') {
        abortReason = null;
      }
      resetInactivity();

      if (!response.body) {
        throw new Error('Ollama Cloud (/v1/responses) returned no response body.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Two-line protocol state: the event type is held until the
      // matching `data:` line arrives. Resets to `null` after dispatch.
      let pendingEvent: string | null = null;

      while (true) {
        if (cancellationToken?.isCancellationRequested) {
          controller.abort();
          break;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }

        chunksReceived += 1;
        resetInactivity();

        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          throw new Error(
            `Ollama Cloud (/v1/responses): SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a newline; aborting to prevent unbounded memory growth.`,
          );
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const stop = processResponsesLine(
            line,
            callbacks,
            resetInactivity,
            (ev: string | null) => {
              pendingEvent = ev;
            },
            () => pendingEvent,
          );
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
            const stop = processResponsesLine(
              line,
              callbacks,
              resetInactivity,
              (ev: string | null) => {
                pendingEvent = ev;
              },
              () => pendingEvent,
            );
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
          // 0 chunks = 0 billed tokens. Surface as error, NOT silent
          // onDone — silent empty success masks provider outage.
          callbacks.onError(new ZeroByteSocketCloseError());
          return;
        }
        // Stream ended without `response.completed`. Treat as done —
        // the server closed the connection cleanly. (Distinct from
        // `/chat/completions`, where `[DONE]` is mandatory; the
        // `/v1/responses` spec lets the server close after
        // `response.completed`.)
        callbacks.onDone();
      }
    } catch (error) {
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
          callbacks.onError(new ConnectTimeoutError(connectTimeoutMs));
          return;
        }
        // ADR 0005 § No mid-stream retry (Revision 2026-08-03) —
        // bare socket close: AbortError with no abortReason tag AND
        // zero chunks received means the connection dropped between
        // the 200 + headers and the first body byte. This is the
        // 0-byte socket close edge case. Surface as a typed error
        // rather than the ambiguous silent `onDone`.
        //
        // LIMITATION: this catch is OUTSIDE the `withRetry` wrapper
        // (which wraps only the initial `fetch` + status check). The
        // reader loop runs after `withRetry` returned, so throwing
        // `ZeroByteSocketCloseError` here does NOT trigger retry — it
        // routes to `callbacks.onError`. Full retry would require
        // restructuring `withRetry` to wrap `fetch + read-first-chunk`
        // (move the reader loop's first iteration inside the wrapper).
        // Deferred to a follow-up — surfacing as error already closes
        // the «worse than double-billing» hole (silent empty success).
        if (abortReason === null && chunksReceived === 0) {
          callbacks.onError(new ZeroByteSocketCloseError());
          return;
        }
        callbacks.onDone();
        return;
      }
      callbacks.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      clearTimeout(maxDurationHandle);
      clearInactivity();
      cancelListener?.dispose();
      if (streamMainAbortListener) {
        controller.signal.removeEventListener('abort', streamMainAbortListener);
        streamMainAbortListener = undefined;
      }
    }
  }
}

/**
 * Parses a single SSE line for the `/v1/responses` two-line protocol.
 *
 * The protocol is:
 *   `event: <type>\n`
 *   `data: <json>\n`
 *   `\n`  (blank line separates events)
 *
 * The parser holds the event type in `pendingEvent` (via the
 * `setPendingEvent` / `getPendingEvent` closures the caller threads
 * through) and dispatches when the `data:` line arrives. A `:` line
 * is a keep-alive comment that resets the inactivity timer.
 *
 * Returns `true` when the stream is complete (`response.completed`,
 * `response.failed`, `response.incomplete`) — the caller stops
 * reading after that.
 */
function processResponsesLine(
  line: string,
  callbacks: StreamCallbacks,
  onKeepAlive: () => void,
  setPendingEvent: (ev: string | null) => void,
  getPendingEvent: () => string | null,
): boolean {
  const trimmed = line.trim();

  // Blank line — event separator. Reset pending event.
  if (!trimmed) {
    return false;
  }

  // SSE comment (keep-alive) — reset inactivity timer.
  if (trimmed.startsWith(':')) {
    onKeepAlive();
    return false;
  }

  // `event:` line — hold the event type for the next `data:` line.
  if (trimmed.startsWith('event:')) {
    const ev = trimmed.slice('event:'.length).trim();
    setPendingEvent(ev || null);
    return false;
  }

  // `data:` line — parse JSON and dispatch on the held event type.
  if (!trimmed.startsWith('data:')) {
    // Unknown line — ignore (defence-in-depth; spec-conformant
    // servers emit only `event:` / `data:` / `:` / blank lines).
    return false;
  }

  const json = trimmed.slice('data:'.length).trim();
  const eventType = getPendingEvent();

  // Reset pending event after consuming it — the next event starts
  // fresh.
  setPendingEvent(null);

  if (!json) {
    return false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch (error) {
    // SSE chunk parse failure is EXPECTED (partial flush, non-JSON
    // keep-alive data). Log redacted preview and skip — do NOT abort.
    logger.warn(
      'Failed to parse Ollama Cloud (/v1/responses) SSE payload (skipping chunk).',
      json.slice(0, 200),
      error,
    );
    return false;
  }

  return dispatchResponsesEvent(eventType, payload, callbacks);
}

/**
 * Dispatches a parsed `/v1/responses` event payload to the stream
 * callbacks. Returns `true` for terminal events
 * (`response.completed` / `response.failed` / `response.incomplete`)
 * so the reader loop stops.
 */
function dispatchResponsesEvent(
  eventType: string | null,
  payload: unknown,
  callbacks: StreamCallbacks,
): boolean {
  const obj = (payload ?? {}) as Record<string, unknown>;

  if (typeof obj.error === 'string' && obj.error) {
    throw new MidStreamError(obj.error);
  }

  switch (eventType) {
    case 'response.reasoning_summary_text.delta': {
      const delta = typeof obj.delta === 'string' ? obj.delta : '';
      if (delta) {
        callbacks.onThinking?.(delta);
      }
      return false;
    }

    case 'response.output_text.delta': {
      const delta = typeof obj.delta === 'string' ? obj.delta : '';
      if (delta) {
        callbacks.onText(delta);
      }
      return false;
    }

    case 'response.output_item.done': {
      const item = obj.item as ResponsesOutputItem | undefined;
      if (item && item.type === 'function_call') {
        callbacks.onToolCall({
          id: item.call_id,
          name: item.name,
          input: safeJsonParse(item.arguments),
        });
      }
      return false;
    }

    case 'response.completed': {
      const response = obj.response as
        | { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }
        | undefined;
      const usage = mapResponsesUsage(response?.usage);
      if (usage) {
        callbacks.onUsage?.(usage);
      }
      callbacks.onDone();
      return true;
    }

    case 'response.failed':
    case 'response.incomplete': {
      const response = obj.response as
        | { error?: { message?: string; type?: string } | null }
        | undefined;
      const message =
        response?.error?.message ||
        (eventType === 'response.failed'
          ? 'Ollama Cloud (/v1/responses): response failed.'
          : 'Ollama Cloud (/v1/responses): response incomplete.');
      callbacks.onError(new Error(redactSensitive(message)));
      return true;
    }

    default:
      // Lifecycle / progress events (`response.created`,
      // `response.in_progress`, `response.output_item.added`,
      // `response.reasoning_summary_text.done`, etc.) carry no
      // user-visible payload for this client. Ignore them.
      return false;
  }
}

function safeJsonParse(value: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    logger.warn(
      'Failed to parse tool-call argument JSON (/v1/responses).',
      value.slice(0, 200),
      error,
    );
  }
  return {};
}

function mapResponsesUsage(
  usage:
    | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    | undefined,
): UsageInfo | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens =
    usage.total_tokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

async function extractErrorMessage(response: HttpResponseLike): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return redactSensitive(
      parsed.error?.message || parsed.message || `HTTP ${response.status}`,
    );
  } catch (error) {
    const preview = body.slice(0, 200);
    logger.warn(
      'Ollama Cloud (/v1/responses) error response was not valid JSON.',
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

// ADR 0005 — timer resolvers. Duplicated from `ollamaClient.ts`
// intentionally: the two clients are independent per ADR 0006 (no
// shared mutable state, no shared deprecation-warning flag). The
// resolver logic is identical; if it drifts, a future refactor can
// extract it to a shared module.
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
  const legacy = config.get<number>('requestTimeoutMs');
  if (typeof legacy === 'number' && !Number.isNaN(legacy) && legacy > 0) {
    if (!maxDurationDeprecationWarned) {
      logger.warn(
        'ollamaCloud.requestTimeoutMs is deprecated; use ollamaCloud.requestMaxDurationMs.',
      );
      maxDurationDeprecationWarned = true;
    }
    return Math.min(legacy, 600000);
  }
  return REQUEST_MAX_DURATION_DEFAULT_MS;
}