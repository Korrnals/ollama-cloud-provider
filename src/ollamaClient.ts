import * as vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import {
  assertBaseUrlAllowed,
  assertBaseUrlAllowedForConnection,
} from './configValidator.js';
import type { ConnectionConfig } from './connections.js';
import { nativeBaseUrl } from './connections.js';
import { httpRequest, type HttpResponseLike } from './httpClient.js';
import { logger, redactSensitive } from './logger.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  NativeChatMessage,
  NativeChatTool,
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

// ADR 0005 — three timers replace the single end-to-end setTimeout.
// Each guard mirrors the package.json schema maximum; below-minimum
// values are accepted (package.json enforces the UI minimum, the
// resolver only guards against garbage). See resolve* docstring.
const REQUEST_CONNECT_TIMEOUT_MAX_MS = 120000;
const REQUEST_CONNECT_TIMEOUT_DEFAULT_MS = 30000;

const REQUEST_INACTIVITY_TIMEOUT_MAX_MS = 600000;
const REQUEST_INACTIVITY_TIMEOUT_DEFAULT_MS = 90000;

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

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  error?: string;
}

/**
 * Phase 1 (2026-08-03 endpoint routing) — selects the wire format
 * `OllamaClient` uses for `/chat` requests.
 *
 *   - `'compat'` (default, backward-compatible) — OpenAI-compatible
 *     `/chat/completions` SSE stream. Existing callers keep working.
 *   - `'native'` — Ollama native `/api/chat` ndjson stream. Top-level
 *     `think`, object-argument `tool_calls`, full-event streaming.
 *
 * See the architectural contract
 * `2026-08-03-ollama-cloud-provider-endpoint-routing-contract.md` §5.1.
 */
export type EndpointFormat = 'compat' | 'native';

/**
 * Phase 1 — native `/api/chat` ndjson chunk. One JSON object per line.
 * The terminal chunk carries `done: true`. Tool calls arrive as a
 * single full-event with `function.arguments` as an OBJECT (not a
 * string), so NO pendingToolCalls accumulation is needed.
 *
 * See spike mnemos `1c8b86f3` for the confirmed shape.
 */
interface NativeChatChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  // Native usage uses prompt_eval_count / eval_count (Ollama schema).
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

export class OllamaClient {
  /**
   * Optional connection the client is bound to. When set, every fetch
   * boundary enforces the connection's own `allowedBaseUrls` whitelist
   * via `assertBaseUrlAllowedForConnection` (the SEC-03 per-connection
   * gate). When unset, the legacy global whitelist via
   * `assertBaseUrlAllowed` is enforced — preserving backward
   * compatibility for the 192 existing tests.
   */
  private readonly connection: ConnectionConfig | undefined;

  /**
   * Phase 1 (2026-08-03 endpoint routing) — wire format used by
   * `streamChat`. `'compat'` (default) preserves the OpenAI-compat
   * `/chat/completions` SSE behaviour; `'native'` switches to the
   * Ollama native `/api/chat` ndjson behaviour.
   */
  private readonly endpointFormat: EndpointFormat;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    connection?: ConnectionConfig,
    endpointFormat: EndpointFormat = 'compat',
  ) {
    this.connection = connection;
    this.endpointFormat = endpointFormat;
  }

  /**
   * Returns the effective fetch URL for chat completions —
   * `baseUrl + openaiCompatiblePath` when bound to a connection, or
   * `baseUrl` as-is otherwise.
   */
  private chatCompletionsUrl(): string {
    if (this.connection) {
      const base = this.connection.baseUrl + this.connection.openaiCompatiblePath;
      return `${base}/chat/completions`;
    }
    return `${this.baseUrl}/chat/completions`;
  }

  /**
   * Phase 1 — returns the native `/api/chat` URL. When bound to a
   * connection, derives the native base from the connection's
   * OpenAI-compat base via `nativeBaseUrl(connection)`; otherwise
   * strips `/v1` from the legacy `baseUrl` and appends `/api`.
   */
  private nativeChatUrl(): string {
    if (this.connection) {
      return `${nativeBaseUrl(this.connection)}/chat`;
    }
    return `${this.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/api/chat`;
  }

  /**
   * Returns the effective fetch URL for `streamChat` based on
   * `endpointFormat`. Used by the connect-phase fetch wrapper.
   */
  private chatUrl(): string {
    return this.endpointFormat === 'native'
      ? this.nativeChatUrl()
      : this.chatCompletionsUrl();
  }

  /**
   * Per-connection whitelist gate. Throws synchronously when the
   * resolved baseUrl is not in the connection's whitelist (or the
   * global whitelist when no connection is bound). The catch block
   * surfaces it to the caller via onError.
   */
  private assertBaseUrlAllowedOrThrow(): void {
    if (this.connection) {
      // Phase 1 — check the EFFECTIVE base (compat OpenAI base or native
      // `/api` base). `assertBaseUrlAllowedForConnection` admits the
      // native `/api` base when it shares the origin of a whitelisted
      // `/v1` base (same-origin, defence-in-depth — see configValidator).
      const effectiveBase =
        this.endpointFormat === 'native'
          ? nativeBaseUrl(this.connection)
          : this.connection.baseUrl + this.connection.openaiCompatiblePath;
      assertBaseUrlAllowedForConnection(effectiveBase, this.connection);
    } else {
      assertBaseUrlAllowed(this.baseUrl);
    }
  }

  async streamChat(
    request: {
      model: string;
      /**
       * Messages in the wire format matching `endpointFormat`. For
       * `'compat'` (default): `OpenAICompatibleMessage[]`. For
       * `'native'`: `NativeChatMessage[]` (object tool-call arguments,
       * `images[]` for vision). The caller (provider) is responsible
       * for converting via `convertMessagesToOpenAI` /
       * `convertMessagesToNative` before calling.
       */
      messages: OpenAICompatibleMessage[] | NativeChatMessage[];
      /**
       * Tools in the wire format matching `endpointFormat`. For
       * `'compat'`: `OpenAICompatibleTool[]`. For `'native'`:
       * `NativeChatTool[]`.
       */
      tools?: OpenAICompatibleTool[] | NativeChatTool[];
      tool_choice?: 'auto' | 'required' | 'none';
      extraBody?: Record<string, unknown>;
    },
    callbacks: StreamCallbacks,
    cancellationToken?: CancellationToken,
  ): Promise<void> {
    // ADR 0005 — three timers replace the single end-to-end setTimeout.
    //   connect      — wraps fetch only, retryable, 30s default
    //   inactivity   — resets per chunk + per :keep-alive, NO retry, 90s
    //   maxDuration  — never reset, NO retry, 30 min safety cap
    // No mid-stream retry: POST /chat/completions is not idempotent.
    const controller = new AbortController();
    const connectTimeoutMs = resolveConnectTimeoutMs();
    const inactivityTimeoutMs = resolveInactivityTimeoutMs();
    const maxDurationMs = resolveMaxDurationMs();

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
        `Ollama Cloud: exceeded max stream duration (${maxDurationMs}ms)`,
      );
      controller.abort();
    }, maxDurationMs);

    // Inactivity: started after fetch resolves (first byte), reset per
    // chunk + per :keep-alive. Declared here so the finally block can
    // clear it from both the stream path and the early-throw path.
    let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
    const resetInactivity = (): void => {
      if (inactivityHandle !== undefined) {
        clearTimeout(inactivityHandle);
      }
      inactivityHandle = setTimeout(() => {
        abortReason = 'inactivity';
        logger.error(
          `Ollama Cloud: stream stalled for ${inactivityTimeoutMs}ms after ${chunksReceived} chunk(s)`,
        );
        controller.abort();
      }, inactivityTimeoutMs);
    };
    const clearInactivity = (): void => {
      if (inactivityHandle !== undefined) {
        clearTimeout(inactivityHandle);
        inactivityHandle = undefined;
      }
    };

    // Count of chunks received — used by the catch block to distinguish
    // connect/first-token (0 chunks) from mid-stream (>0 chunks) for
    // error messages. NOT used for retry decisions (no retry regardless).
    let chunksReceived = 0;

    // Combine the caller's CancellationToken with our timers. See the
    // race note below — a cancel that arrived during async setup before
    // streamChat was entered must be detected synchronously.
    const cancelListener = cancellationToken?.onCancellationRequested(() => {
      abortReason = 'cancel';
      controller.abort();
    });
    if (cancellationToken?.isCancellationRequested) {
      abortReason = 'cancel';
      controller.abort();
    }

    let done = false;

    // ADR 0005 — per-attempt abort wiring. See the comment above
    // `withRetry` for the full rationale. Declared in the function
    // scope (not inside `try`) so the outer `finally` can detach the
    // main→attempt listener once the stream is done.
    let streamMainAbortListener: (() => void) | undefined;

    try {
      this.assertBaseUrlAllowedOrThrow();

      const { extraBody, ...baseRequest } = request;
      const body = this.endpointFormat === 'native'
        ? JSON.stringify(buildNativeRequestBody(baseRequest, extraBody))
        : JSON.stringify({
          ...baseRequest,
          ...extraBody,
          stream: true,
          stream_options: { include_usage: true },
        });

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
      // NOT the main `controller`. Reusing the main controller was a
      // bug: when the connect timer fired (30s), `controller.abort()`
      // marked the signal as aborted permanently. `withRetry` retried,
      // but `fetch(url, { signal: aborted })` failed instantly on
      // every subsequent attempt — all retries wasted, user saw
      // "connect timeout after 30000ms" even though retry should have
      // attempted a fresh connection.
      //
      // Each retry attempt gets its own fresh `attemptController`. The
      // main `controller` (cancel / maxDuration / inactivity) is wired
      // to abort the attempt controller too, so a caller cancel or
      // max-duration fire still short-circuits the in-flight fetch AND
      // the stream reader loop. The wire must stay live for the entire
      // stream phase (not just the connect phase) because the stream
      // body is tied to `attemptController.signal` — that is how the
      // inactivity / maxDuration / cancel aborts reach `reader.read()`.
      // The connect timer fires only the per-attempt controller; retry
      // gets a fresh signal on the next iteration.
      //
      // `streamMainAbortListener` (declared in the function scope
      // above) holds the successful attempt's main→attempt wire so the
      // outer `finally` can detach the listener once the stream is
      // done. On a retried attempt the previous wire is detached
      // before the next attempt installs its own.
      const response = await withRetry(
        async () => {
          // Detach any previous attempt's main→attempt wire before
          // installing a fresh one. On the first attempt there is no
          // previous wire; on retries the prior attempt's controller
          // is dead (its connect timer aborted it) but its listener
          // is still attached to the main controller — remove it so
          // we do not leak one listener per retry.
          if (streamMainAbortListener) {
            controller.signal.removeEventListener('abort', streamMainAbortListener);
            streamMainAbortListener = undefined;
          }

          const attemptController = new AbortController();
          const connectHandle = setTimeout(() => {
            // Only tag as connect if no higher-priority reason fired.
            // (cancel is set synchronously above; maxDuration is
            // independent and may have fired first.)
            if (abortReason === null) {
              abortReason = 'connect';
            }
            attemptController.abort();
          }, connectTimeoutMs);

          // If the main controller already aborted (caller cancel or
          // maxDuration fired before this attempt started), abort the
          // attempt immediately so fetch rejects right away rather
          // than hanging until the connect timer fires.
          if (controller.signal.aborted) {
            attemptController.abort();
          }
          // Propagate a mid-attempt main-controller abort (cancel or
          // maxDuration firing while fetch is in flight) to the
          // attempt controller so fetch rejects promptly. The same
          // wire keeps the stream reader abortable after fetch
          // resolves — see the comment above `withRetry`.
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
            const res = await httpRequest(this.chatUrl(), {
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
            // If the connect timer fired (and ONLY the connect timer
            // — not a cancel/maxDuration that also aborted the
            // attempt controller via the main→attempt wire), surface
            // a typed ConnectTimeoutError so defaultRetryOn can
            // retry. When abortReason is 'cancel' or 'maxDuration',
            // rethrow the raw AbortError unchanged — retryOn returns
            // false for bare AbortError, so withRetry stops and the
            // outer catch routes by abortReason.
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
            // abortable. On a failed attempt (connect timeout /
            // cancel / maxDuration) detach now; the next attempt (if
            // any) installs a fresh wire at its top.
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
      // Start the inactivity timer (resets per chunk / keep-alive).
      // Clear any connect-phase abort tag so a later inactivity fire
      // is not misread as a connect timeout. The cast is needed because
      // TS control-flow narrows `abortReason` after the cancel check
      // above and does not account for closure reassignments from the
      // timer callbacks.
      if ((abortReason as AbortReason) === 'connect') {
        abortReason = null;
      }
      resetInactivity();

      if (!response.body) {
        throw new Error('Ollama Cloud returned no response body.');
      }

      const pendingToolCalls = new Map<number, OpenAICompatibleToolCall>();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Phase 1 — native mode uses ndjson parsing (no pendingToolCalls
      // accumulation: tool_calls arrive as one full-event with object
      // arguments). Compat mode keeps the SSE + pendingToolCalls path.
      const processLineForFormat = (line: string): boolean => {
        if (this.endpointFormat === 'native') {
          return processNdjsonLine(line, callbacks);
        }
        return processLine(line, pendingToolCalls, callbacks, resetInactivity);
      };

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
        // MEDIUM-2 — unbounded stream buffer is a DoS vector. A malformed
        // or hostile stream that never emits a newline would grow
        // `buffer` without limit. Cap at 1 MiB; if exceeded, abort with
        // an error rather than continuing to accumulate memory.
        // (Phase 1: applies to BOTH SSE and ndjson — format-agnostic.)
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          throw new Error(
            `Ollama Cloud: stream buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a newline; aborting to prevent unbounded memory growth.`,
          );
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const stop = processLineForFormat(line);
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
            const stop = processLineForFormat(line);
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
          // (Phase 1: format-agnostic — applies to SSE AND ndjson.)
          callbacks.onError(new ZeroByteSocketCloseError());
          return;
        }
        // Phase 1 — native mode emits tool_calls as a full-event (no
        // accumulation), so there is nothing to flush. Compat mode
        // flushes accumulated pending tool calls before onDone.
        if (this.endpointFormat !== 'native') {
          flushToolCalls(pendingToolCalls, callbacks);
        }
        callbacks.onDone();
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
          // Connect abort that escaped withRetry (e.g. maxRetries=0
          // and the wrapper rethrew before our ConnectTimeoutError
          // translation, or a race where cancel arrived mid-fetch).
          // Treat as connect timeout for the user-facing message.
          callbacks.onError(new ConnectTimeoutError(connectTimeoutMs));
          return;
        }
        // ADR 0005 § No mid-stream retry (Revision 2026-08-03) —
        // bare socket close: AbortError with no abortReason tag AND
        // zero chunks received means the connection dropped between
        // the 200 + headers and the first body byte. This is the
        // 0-byte socket close edge case. Surface as a typed error via
        // `classifyStreamError` rather than the ambiguous silent
        // `onDone`.
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
        // Ambiguous AbortError with no tag — caller-cancel is the
        // safest default (matches v0.4.x behaviour for bare aborts).
        callbacks.onDone();
        return;
      }
      // Non-abort errors (HttpError, whitelist throw, buffer overrun,
      // ConnectTimeoutError that withRetry gave up on) — surface directly.
      callbacks.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      clearTimeout(maxDurationHandle);
      clearInactivity();
      cancelListener?.dispose();
      // Detach any lingering main→attempt abort wire from the last
      // `withRetry` attempt. On a clean stream the wire is still
      // attached (it kept the reader abortable); on a failed stream
      // it may already have been detached by the attempt's finally —
      // removeEventListener is a no-op if the listener was not added,
      // so calling it unconditionally is safe.
      if (streamMainAbortListener) {
        controller.signal.removeEventListener('abort', streamMainAbortListener);
        streamMainAbortListener = undefined;
      }
    }
  }
}

function processLine(
  line: string,
  pendingToolCalls: Map<number, OpenAICompatibleToolCall>,
  callbacks: StreamCallbacks,
  onKeepAlive?: () => void,
): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) {
    // ADR 0005 — `: keep-alive` SSE comment resets the inactivity
    // timer. Ollama Cloud does not emit these (spike 1), but the reset
    // path is defense-in-depth for future providers that do.
    if (trimmed.startsWith(':') && onKeepAlive) {
      onKeepAlive();
    }
    return false;
  }

  if (trimmed === 'data: [DONE]') {
    flushToolCalls(pendingToolCalls, callbacks);
    callbacks.onDone();
    return true;
  }

  if (!trimmed.startsWith('data: ')) {
    return false;
  }

  const json = trimmed.slice(6);
  let chunk: OpenAIStreamChunk;
  try {
    chunk = JSON.parse(json) as OpenAIStreamChunk;
  } catch (error) {
    // Issue 10 — SSE chunk parse failure is EXPECTED. SSE is
    // line-oriented; a partial or non-JSON `data:` line is normal
    // (keep-alive comments, provider-specific preamble, partial flush).
    // Log it (redacted via the hardened logger) and skip this chunk —
    // do NOT abort the stream. This is distinct from a full-response
    // parse failure, which IS a real error (see extractErrorMessage).
    logger.warn(
      'Failed to parse Ollama Cloud SSE payload (skipping chunk).',
      json.slice(0, 200),
      error,
    );
    return false;
  }

  if (typeof chunk.error === 'string' && chunk.error) {
    throw new MidStreamError(chunk.error);
  }

  const usage = mapUsage(chunk.usage);
  if (usage) {
    callbacks.onUsage?.(usage);
  }

  const choice = chunk.choices?.[0];
  if (!choice?.delta) {
    return false;
  }

  if (choice.delta.reasoning) {
    callbacks.onThinking?.(choice.delta.reasoning);
  }

  if (choice.delta.content) {
    callbacks.onText(choice.delta.content);
  }

  if (choice.delta.tool_calls) {
    for (const toolCall of choice.delta.tool_calls) {
      let pending = pendingToolCalls.get(toolCall.index);
      if (!pending && toolCall.id) {
        pending = {
          id: toolCall.id,
          type: 'function',
          function: {
            name: '',
            arguments: '',
          },
        };
        pendingToolCalls.set(toolCall.index, pending);
      }

      if (pending) {
        if (toolCall.function?.name) {
          pending.function.name += toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          pending.function.arguments += toolCall.function.arguments;
        }
      }
    }
  }

  if (choice.finish_reason === 'tool_calls') {
    flushToolCalls(pendingToolCalls, callbacks);
  }

  return false;
}

function flushToolCalls(
  pendingToolCalls: Map<number, OpenAICompatibleToolCall>,
  callbacks: StreamCallbacks,
): void {
  for (const toolCall of pendingToolCalls.values()) {
    callbacks.onToolCall({
      id: toolCall.id,
      name: toolCall.function.name,
      input: safeJsonParse(toolCall.function.arguments),
    });
  }
  pendingToolCalls.clear();
}

/**
 * Phase 1 (2026-08-03 endpoint routing) — builds the native `/api/chat`
 * request body. Differs from the OpenAI-compat body:
 *
 *   - `stream: true` (no `stream_options` — native has no per-chunk
 *     usage; usage arrives on the terminal `done: true` chunk).
 *   - `messages` and `tools` are shaped by `convertMessagesToNative` /
 *     `convertToolsToNative` BEFORE reaching the client (the provider
 *     passes the already-converted objects in `request.messages` /
 *     `request.tools`). The client only adds `stream` here.
 *   - `extraBody` (e.g. `think`, `options`) merges top-level — the
 *     `modelConfiguration` native path emits `think` /
 *     `options` directly in `extraBody.openaiBody`.
 *
 * `tool_choice` passes through unchanged (native accepts the same
 * `'auto' | 'required' | 'none'` values).
 */
function buildNativeRequestBody(
  baseRequest: {
    model: string;
    messages: OpenAICompatibleMessage[] | NativeChatMessage[];
    tools?: OpenAICompatibleTool[] | NativeChatTool[];
    tool_choice?: 'auto' | 'required' | 'none';
  },
  extraBody: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...baseRequest,
    stream: true,
  };
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      body[key] = value;
    }
  }
  return body;
}

/**
 * Phase 1 — parses one ndjson line of a native `/api/chat` stream.
 *
 * Native ndjson: one JSON object per line, NO `data:` prefix, NO
 * `[DONE]` marker. The terminal chunk carries `done: true`. Tool calls
 * arrive as a SINGLE full-event with `function.arguments` as an OBJECT
 * (not a string) — so NO `pendingToolCalls` accumulation is needed
 * (spike mnemos `1c8b86f3`).
 *
 * Returns `true` when the stream is terminal (the caller stops reading
 * after a terminal line); `false` to continue.
 *
 * Error handling mirrors `processLine`:
 *   - `{"error":"..."}` → throw `MidStreamError` (surfaces via the
 *     outer catch → `classifyStreamError` in the provider).
 *   - JSON parse failure on a non-empty line → log + skip (defence
 *     against a partial final line; same posture as the SSE path).
 *   - Empty line → skip (ndjson separators are bare `\n`).
 */
function processNdjsonLine(
  line: string,
  callbacks: StreamCallbacks,
): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  let chunk: NativeChatChunk;
  try {
    chunk = JSON.parse(trimmed) as NativeChatChunk;
  } catch (error) {
    // A partial or non-JSON ndjson line is unexpected for native
    // (ndjson is one full JSON object per line), but a trailing partial
    // line on a dropped connection is possible. Log redacted and skip
    // — do NOT abort the stream. Mirrors the SSE path's posture.
    logger.warn(
      'Failed to parse Ollama native /api/chat ndjson line (skipping).',
      trimmed.slice(0, 200),
      error,
    );
    return false;
  }

  if (typeof chunk.error === 'string' && chunk.error) {
    throw new MidStreamError(chunk.error);
  }

  // Native usage arrives on the terminal chunk (prompt_eval_count /
  // eval_count). Emit when present.
  const usage = mapNativeUsage(chunk);
  if (usage) {
    callbacks.onUsage?.(usage);
  }

  const message = chunk.message;
  if (message) {
    if (message.thinking) {
      callbacks.onThinking?.(message.thinking);
    }
    if (message.content) {
      callbacks.onText(message.content);
    }
    // Native tool_calls: FULL-EVENT, object arguments. Emit each call
    // immediately — NO pendingToolCalls accumulation.
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        const id = toolCall.id ?? '';
        const name = toolCall.function?.name ?? '';
        const input =
          (toolCall.function?.arguments as Record<string, unknown> | undefined) ??
          {};
        callbacks.onToolCall({ id, name, input });
      }
    }
  }

  // Terminal chunk: `done: true`. No `[DONE]` marker in native ndjson.
  if (chunk.done === true) {
    callbacks.onDone();
    return true;
  }

  return false;
}

/**
 * Phase 1 — maps native `/api/chat` usage fields to `UsageInfo`. Native
 * Ollama uses `prompt_eval_count` / `eval_count` (NOT `prompt_tokens` /
 * `completion_tokens`). Returns `undefined` when no counts are present
 * (e.g. intermediate chunks before the terminal `done: true` chunk).
 */
function mapNativeUsage(chunk: NativeChatChunk): UsageInfo | undefined {
  const inputTokens = chunk.prompt_eval_count;
  const outputTokens = chunk.eval_count;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * ADR 0005 — reads, clamps, and resolves the three streaming timers.
 *
 * Each resolver guards against non-number / NaN / non-positive values
 * (returns the default). For positive numbers below the package.json
 * `minimum` or above `maximum`, the resolver logs a warning and
 * **clamps to the nearest bound** — EXCEPT when the value is below the
 * minimum, in which case it is used as-is. Rationale: package.json
 * enforces the policy range in the Settings UI; the resolver's job is
 * to guard against garbage (NaN, 0, negative), not to second-guess a
 * user or test that deliberately set a small value. Below-minimum
 * values are legitimate for tests and for power users with unusual
 * workloads; above-maximum values are clamped because they would
 * disable the timer's safety purpose.
 *
 * `resolveMaxDurationMs` also honours the deprecated
 * `ollamaCloud.requestTimeoutMs` alias: if `requestTimeoutMs` is set
 * but `requestMaxDurationMs` is NOT, the legacy value (clamped to its
 * own legacy range) is used as the max-duration cap, preserving
 * backward compatibility for v0.4.0-era configs. A deprecation
 * warning is logged once per process.
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

async function extractErrorMessage(response: HttpResponseLike): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    // MEDIUM-1 — redact the parsed error message before it propagates
    // to the user-facing `Error.message` (via `HttpError` →
    // `callbacks.onError` → VS Code notification). A malicious proxy
    // can reflect the caller's `Authorization: Bearer <key>` header in
    // a JSON `error.message` string; without this redaction the key
    // would surface in the VS Code error notification. `logger.warn`
    // already redacts its own output, but the `Error.message` path is
    // separate and was unfiltered.
    return redactSensitive(
      parsed.error?.message || parsed.message || `HTTP ${response.status}`,
    );
  } catch (error) {
    // Issue 10 — full-response parse failure is UNEXPECTED. A non-JSON
    // error body (e.g. an HTML error page from a proxy, a partial
    // response from a dropped connection) can mask an attack or a
    // misconfigured gateway. Surface it: log the redacted first 200
    // chars and the parse error, then return a message that includes
    // both, so the caller sees the real failure mode rather than a
    // generic "HTTP 502".
    const preview = body.slice(0, 200);
    logger.warn(
      'Ollama Cloud error response was not valid JSON. Surfacing raw body preview.',
      preview,
      error,
    );
    if (!body) {
      return `HTTP ${response.status}`;
    }
    // MEDIUM-1 — the preview is raw response body and may carry a
    // reflected secret (e.g. an HTML page echoing the Authorization
    // header). Redact before the preview is embedded in the message
    // that flows to the user-facing notification.
    return redactSensitive(
      `HTTP ${response.status} (non-JSON body, first 200 chars logged): ${preview}`,
    );
  }
}

/**
 * Issue 10 — hardened safeJsonParse for tool-call arguments.
 *
 * Tool-call argument strings come from the model's streamed output and
 * are frequently incomplete until all deltas arrive. A parse failure
 * here is expected during streaming (the caller flushes accumulated
 * arguments at finish_reason), so we do NOT throw — we log the redacted
 * preview and return an empty object, preserving the streaming contract.
 *
 * This is distinct from `extractErrorMessage`: that handles a full HTTP
 * error body (unexpected → surface). This handles a streamed tool-arg
 * fragment (expected → log + default).
 */
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
    // Expected during streaming — log redacted preview + parse error.
    logger.warn(
      'Failed to parse tool-call argument JSON (expected during streaming).',
      value.slice(0, 200),
      error,
    );
  }

  return {};
}

function mapUsage(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_eval_count?: number;
        eval_count?: number;
      }
    | undefined,
): UsageInfo | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = usage.prompt_tokens ?? usage.prompt_eval_count;
  const outputTokens = usage.completion_tokens ?? usage.eval_count;
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

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}
