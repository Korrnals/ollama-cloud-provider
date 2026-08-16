import type { CancellationToken } from 'vscode';
import {
  assertBaseUrlAllowed,
  assertBaseUrlAllowedForConnection,
} from './configValidator.js';
import type { ConnectionConfig } from './connections.js';
import { nativeBaseUrl } from './connections.js';
import { httpRequest } from './httpClient.js';
import { logger } from './logger.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  NativeChatMessage,
  NativeChatTool,
  StreamCallbacks,
  UsageInfo,
} from './protocolTypes.js';
import { HttpError, MidStreamError } from './retry.js';
import {
  readStream,
  type StreamLineContext,
  type StreamFinalizer,
} from './streamReader.js';

// ADR 0010 — the timer constants, MAX_SSE_BUFFER_BYTES, and resolve*
// helpers that formerly lived here have moved to `streamReader.ts`.
// This client no longer owns the streaming lifecycle; it delegates to
// `readStream` and injects endpoint-specific parsing via callbacks.

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
        // Bug 2 fix — the server returns `function.index` inside
        // tool_calls (confirmed via curl: glm-5.2 sends
        // {"function":{"index":0,...}}). The field is informational
        // for native (full-event, no delta accumulation) but must be
        // present in the type for accuracy and forward-compat.
        index?: number;
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

  /**
   * v0.12.0 ADR 0012 — optional SSRF guard. When set, it is passed
   * to `readStream` and runs inside `withRetry` before every fetch.
   * Tests pass `undefined` to disable; production wires
   * `createProductionSsrfGuard()`. Local Ollama connections may opt
   * out (loopback is legitimate for them).
   */
  private readonly ssrfGuard:
    | { assertUrlAllowed(url: string): Promise<void> }
    | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    connection?: ConnectionConfig,
    endpointFormat: EndpointFormat = 'compat',
    ssrfGuard?: { assertUrlAllowed(url: string): Promise<void> },
  ) {
    this.connection = connection;
    this.endpointFormat = endpointFormat;
    this.ssrfGuard = ssrfGuard;
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
    // SEC-03 — enforce the per-connection / global baseUrl whitelist
    // BEFORE any network call. This stays in the client (ADR 0010
    // module boundary); the shared streamReader does NOT re-check.
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    // Protocol state stays in the client closure (ADR 0010 condition #1
    // — the module does NOT see endpoint-specific state). For compat
    // mode, pendingToolCalls accumulates streamed tool-call deltas
    // across chunks until [DONE] or stream end. For native mode, no
    // accumulation is needed (tool_calls arrive as one full-event).
    const pendingToolCalls = new Map<number, OpenAICompatibleToolCall>();

    // Condition #2 — the callback carries the terminal condition. The
    // shared module does NOT hardcode [DONE] or done:true.
    const processLineForFormat = (line: string, ctx: StreamLineContext): boolean => {
      const result = this.endpointFormat === 'native'
        ? processNdjsonLine(line, callbacks)
        : processLine(line, pendingToolCalls, callbacks, ctx.resetInactivity);
      // ArchCom 0011c: mark as parsed when the line was meaningful
      // (not empty, not a comment, not skipped). Both processLine and
      // processNdjsonLine return false for non-meaningful lines and
      // process them for meaningful ones — so we check if the line
      // had content and wasn't a bare newline/comment.
      if (line.trim() && !line.startsWith(':')) {
        ctx.markParsed();
      }
      return result;
    };

    // Condition #1 — optional finalize for compat mode's flushToolCalls.
    // Native mode has no accumulation, so no finalize. The finalize
    // fires ONLY on natural stream-end without a terminal line from
    // the callback (the callback owns [DONE] termination itself).
    const finalize: StreamFinalizer | undefined =
      this.endpointFormat === 'native'
        ? undefined
        : (cb: StreamCallbacks) => {
          flushToolCalls(pendingToolCalls, cb);
          cb.onDone();
        };

    // ADR 0010 — delegate the invariant streaming lifecycle to the
    // shared module. Three timers, withRetry connect wrapper, reader
    // loop + buffer cap, chunksReceived, socket-close reclassification,
    // AbortError routing, finally cleanup — all owned by readStream.
    await readStream(
      {
        logTag: 'Ollama Cloud',
        url: this.chatUrl(),
        headers,
        body,
        cancellationToken,
        processLine: processLineForFormat,
        finalize,
        ssrfGuard: this.ssrfGuard,
      },
      callbacks,
    );
  }

  /**
   * v0.13.0 Slice 2 — ONE-SHOT non-streaming native `/api/chat` call
   * for the compaction summarizer (spec: docs/compaction-spec.md
   * § Slice 2). Unlike `streamChat` this goes straight through
   * `httpRequest` — no `readStream`, no `withRetry`, no timers beyond
   * the caller's AbortSignal: the summarizer contract is a SINGLE
   * call per compaction event (the 5-minute rate guard upstream caps
   * frequency; a retry here would double-bill the cheap-model quota).
   *
   * Reuses the client's URL / auth / whitelist path:
   *   - URL: `nativeChatUrl()` — always the native `/api/chat`
   *     endpoint, regardless of this client's `endpointFormat`.
   *   - SEC-03 whitelist: native-base semantics (connection clients
   *     gate on `nativeBaseUrl(connection)` — the validator admits
   *     the `/api` base sharing the origin of a whitelisted `/v1`
   *     base; legacy clients gate on the globally whitelisted
   *     `baseUrl` the native URL is derived from).
   *   - ADR 0012 SSRF guard re-resolves the hostname right before
   *     the fetch, same as the streaming path.
   *
   * The body is owned by the caller (`createSummarizer` builds
   * `{ model, messages, stream: false, think: false }`) and is
   * serialised verbatim. Returns `message.content`; throws on
   * non-2xx, transport error, abort, or a missing/empty content —
   * every throw makes the provider fall back to the uncompacted
   * history (fallback contract).
   */
  async nativeChatOnce(body: unknown, signal?: AbortSignal): Promise<string> {
    const url = this.nativeChatUrl();
    if (this.connection) {
      assertBaseUrlAllowedForConnection(
        nativeBaseUrl(this.connection),
        this.connection,
      );
    } else {
      assertBaseUrlAllowed(this.baseUrl);
    }
    if (this.ssrfGuard) {
      await this.ssrfGuard.assertUrlAllowed(url);
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const res = await httpRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new HttpError(
        res.status,
        `Native /api/chat one-shot call failed (${res.status} ${res.statusText}): ${detail}`,
      );
    }
    const raw = await res.text();
    let json: { message?: { content?: unknown }; error?: unknown };
    try {
      json = JSON.parse(raw) as { message?: { content?: unknown } };
    } catch (error) {
      logger.warn(
        'Native /api/chat one-shot call returned a non-JSON body.',
        raw.slice(0, 200),
        error,
      );
      throw new Error(
        'Native /api/chat one-shot call returned a non-JSON body.',
      );
    }
    if (typeof json.error === 'string' && json.error) {
      throw new MidStreamError(json.error);
    }
    const content = json.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(
        'Native /api/chat one-shot call returned no message.content.',
      );
    }
    return content;
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
      // Bug 1 fix (compat path) — same vulnerability as native: an
      // empty `id` breaks VS Code tool-result routing. The compat
      // delta-accumulation path only creates a pending entry when the
      // first delta carries an id, but a server that sends the id on
      // a later delta (or not at all) would leave `id` unset. Guard
      // with the same fallback generator.
      id: toolCall.id || generateToolCallId(),
      name: toolCall.function.name,
      input: safeJsonParse(toolCall.function.arguments),
    });
  }
  pendingToolCalls.clear();
}

/**
 * Bug 1 fix — generates a fallback tool-call id when the model omits
 * one. VS Code's `LanguageModelToolCallPart.callId` must be non-empty
 * for tool-result correlation. The id is `call_<timestamp>_<rand>` —
 * unique within a stream, stable enough for the single response.
 */
function generateToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
        // Bug 1 fix — VS Code's LanguageModelToolCallPart requires a
        // non-empty `callId` for the tool result to route back. When
        // the model omits `id` (some native servers / models do), an
        // empty string breaks tool-result correlation and crashes VS
        // Code subagents with a `tryDeserialize` error. Generate a
        // stable fallback id so the callId is never empty.
        const id = toolCall.id ?? generateToolCallId();
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

// ADR 0010 / 0012 (revised) — the single timer resolver
// (`resolveMaxDurationMs`) and `extractErrorMessage` have moved to
// `streamReader.ts`. This client no longer owns the streaming
// lifecycle. Connect + inactivity timers were removed (ADR 0012
// revised); only max-duration (60 min) remains.

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
