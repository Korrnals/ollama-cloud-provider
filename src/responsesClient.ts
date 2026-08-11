// ADR 0006 — `/v1/responses` streaming client.
//
// ADR 0010 — the invariant streaming lifecycle (three timers, the
// `withRetry` connect wrapper, the reader loop + 1 MiB buffer cap,
// `chunksReceived` tracking, socket-close reclassification,
// AbortError routing, `finally` cleanup, and the `resolve*` helpers +
// constants) now lives in `streamReader.ts`. This client no longer
// owns that lifecycle; it delegates to `readStream` and injects
// endpoint-specific parsing via callbacks (the two-line SSE parser).
//
// Endpoint-specific responsibilities kept in this client (ADR 0010
// module boundary):
//
// - URL: `${openAiBaseUrl}/responses` (not `/chat/completions`).
// - Request body: `{ model, input[], instructions?, tools?, stream:true }`
//   (not `messages[]`). Built by `convertResponses.ts`.
// - `assertBaseUrlAllowedOrThrow` (SEC-03 per-connection whitelist).
// - Stream protocol: SSE `event:` + `data:` two-line pairs. The
//   parser holds a `pendingEvent` string and dispatches on the event
//   type when the `data:` line arrives. There is NO `data: [DONE]`
//   marker — termination is `response.completed`.
// - Tool calls: a single `response.output_item.done` event with
//   `item.type === 'function_call'` carries the full call (no
//   delta-accumulation needed — the endpoint emits the complete
//   arguments string in one event). Hence NO `finalize` callback.
import type { CancellationToken } from 'vscode';
import {
  assertBaseUrlAllowed,
  assertBaseUrlAllowedForConnection,
} from './configValidator.js';
import type { ConnectionConfig } from './connections.js';
import { openAiBaseUrl } from './connections.js';
import { logger, redactSensitive } from './logger.js';
import type {
  ResponsesInputItem,
  ResponsesTool,
  ResponsesOutputItem,
  StreamCallbacks,
  UsageInfo,
} from './protocolTypes.js';
import { MidStreamError } from './retry.js';
import {
  readStream,
  type StreamLineContext,
} from './streamReader.js';

// ADR 0010 — the timer constants, MAX_SSE_BUFFER_BYTES, and resolve*
// helpers that formerly lived here have moved to `streamReader.ts`.
// This client no longer owns the streaming lifecycle; it delegates to
// `readStream` and injects endpoint-specific parsing via callbacks.

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
    // SEC-03 — enforce the per-connection / global baseUrl whitelist
    // BEFORE any network call. This stays in the client (ADR 0010
    // module boundary); the shared streamReader does NOT re-check.
    // Mirrors `ollamaClient.streamChat` (Phase 2).
    this.assertBaseUrlAllowedOrThrow();

    const { extraBody, ...baseRequest } = request;
    const body = JSON.stringify({
      ...baseRequest,
      ...extraBody,
      stream: true,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    // Protocol state stays in the client closure (ADR 0010 condition
    // #1 — the module does NOT see endpoint-specific state). The
    // two-line SSE protocol holds the event type in `pendingEvent`
    // until the matching `data:` line arrives; resets to `null` after
    // dispatch.
    let pendingEvent: string | null = null;

    // Condition #2 — the callback carries the terminal condition. The
    // shared module does NOT hardcode `response.completed`. The
    // callback returns `true` when the stream is complete.
    const processResponsesLineForStream = (
      line: string,
      ctx: StreamLineContext,
    ): boolean => {
      const result = processResponsesLine(
        line,
        callbacks,
        ctx.resetInactivity,
        (ev: string | null) => {
          pendingEvent = ev;
        },
        () => pendingEvent,
      );
      // ArchCom 0011c: mark as parsed for meaningful lines.
      if (line.trim() && !line.startsWith(':')) {
        ctx.markParsed();
      }
      return result;
    };

    // ADR 0010 — delegate the invariant streaming lifecycle to the
    // shared module. Three timers, the `withRetry` connect wrapper,
    // the reader loop + 1 MiB buffer cap, `chunksReceived` tracking,
    // socket-close reclassification, AbortError routing, and `finally`
    // cleanup are all owned by `readStream`.
    //
    // NO `finalize` callback: the `/v1/responses` endpoint emits each
    // `function_call` complete in one `response.output_item.done`
    // event (no delta-accumulation), so there is nothing to flush on a
    // clean stream end. A clean end without `response.completed` routes
    // to `callbacks.onDone()` directly inside `readStream`.
    await readStream(
      {
        logTag: 'Ollama Cloud (/v1/responses)',
        url: this.responsesUrl(),
        headers,
        body,
        cancellationToken,
        processLine: processResponsesLineForStream,
      },
      callbacks,
    );
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
