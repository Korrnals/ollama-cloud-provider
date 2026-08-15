export interface OpenAICompatibleToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAICompatibleTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Vision support — content parts for OpenAI-compatible chat messages.
 * A message's `content` can be a plain string OR an array of typed parts
 * (text + image_url) when the model supports vision.
 */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string };
    };

export type OpenAIChatContent = string | OpenAIContentPart[] | null;

export interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAIChatContent;
  tool_call_id?: string;
  tool_calls?: OpenAICompatibleToolCall[];
  reasoning_content?: string;
  // ADR 0007 — recognised but non-essential metadata. `name` is the
  // optional sender label; `refusal` is the assistant refusal text.
  // Both survive `safe`; `aggressive` strips `name` always and
  // `refusal` only when empty.
  name?: string;
  refusal?: string;
}

// ---------------------------------------------------------------------------
// Phase 1 (2026-08-03 endpoint routing) — native `/api/chat` types.
//
// Native Ollama `/api/chat` uses a DIFFERENT message shape than the
// OpenAI-compat `/chat/completions`:
//   - `tool_calls[].function.arguments` is an OBJECT (not a string).
//   - Vision images are a top-level `images: ["base64..."]` array on the
//     user message (NOT `image_url` content parts).
//   - `tools[].function.parameters` is the same shape as compat.
//
// The native message type is intentionally SEPARATE from
// `OpenAICompatibleMessage` so the two wire formats never cross wires.
// `convertMessagesToNative` produces `NativeChatMessage[]`; the
// `OllamaClient` native path serialises them verbatim.
// ---------------------------------------------------------------------------

/**
 * Native `/api/chat` tool call. `arguments` is an OBJECT (parsed), not
 * a JSON string — the native endpoint accepts and returns object
 * arguments directly (spike mnemos `1c8b86f3`).
 */
export interface NativeChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Native `/api/chat` tool definition. Same shape as
 * `OpenAICompatibleTool` (kept as a distinct type so the two wire
 * formats stay separable).
 */
export interface NativeChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Native `/api/chat` message. `content` is a string (native does not
 * use content-part arrays — images go in `images`). `tool_calls` carry
 * object arguments. `images` is a base64 (data-URL-stripped) array on
 * user messages only.
 */
export interface NativeChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: NativeChatToolCall[];
  images?: string[];
  // ADR 0007 — assistant reasoning content passes through the context
  // filter untouched; `convertOpenAIMessagesToNative` forwards it so
  // the native path preserves what the OpenAI-format payload carried
  // (serialised verbatim by `buildNativeRequestBody`).
  reasoning_content?: string;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamCallbacks {
  onText: (text: string) => void;
  onToolCall: (toolCall: ToolCallEvent) => void;
  onThinking?: (text: string) => void;
  onUsage?: (usage: UsageInfo) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// /v1/responses request and streaming event types (ADR 0006).
//
// The `/chat/completions` types above remain the fallback path and stay
// untouched. The types below mirror the OpenAI `/v1/responses` API shape
// as confirmed by the 2026-07-27 spike on Ollama Cloud. Stateful fields
// (previous_response_id, store, background, metadata) are intentionally
// OMITTED — ADR 0001 thin-provider rule + ADR 0006 § "No stateful
// features".
// ---------------------------------------------------------------------------

/**
 * A single input item for `/v1/responses`. The endpoint uses a
 * typed `input[]` array instead of the `messages[]` array used by
 * `/chat/completions`. Most items are `message` items carrying `role`
 * and a `content[]` array of typed parts. Tool calls and tool results
 * are top-level items (`function_call` / `function_call_output`),
 * NOT content parts inside a message — this is the key structural
 * difference from `/chat/completions` that caused the v0.6.0 regression
 * (the server rejects `tool_call_output` as a content type inside a
 * message's `content[]`).
 */
export type ResponsesInputItem =
  | {
      type: 'message';
      role: 'user' | 'assistant' | 'system';
      content: ResponsesContentPart[];
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    };

/**
 * Content part for a `/v1/responses` input message. `input_text` and
 * `input_image` cover user input (text + vision); `output_text` is the
 * assistant's emitted text (for conversational history).
 *
 * `tool_call_output` is intentionally NOT a content part — it is a
 * top-level input item (`function_call_output`). The v0.6.0 release
 * incorrectly placed it inside `message.content[]`, which the server
 * rejected with `unknown content type: tool_call_output`.
 */
export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string };

/**
 * Full `/v1/responses` request body. `stream: true` is required for
 * streaming (the only mode this extension uses). `instructions` is the
 * hoisted system prompt (top-level, NOT a `role:system` message in
 * `input`). `truncation: 'disabled'` is the safe default — the
 * extension does not auto-truncate conversation history.
 */
export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  stream: true;
  tools?: ResponsesTool[];
  tool_choice?: 'auto' | 'required' | 'none';
  text?: { format: { type: 'text' | 'json_schema' } };
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  truncation?: 'disabled' | 'auto';
}

/**
 * Tool definition for `/v1/responses`. Same logical schema as
 * `OpenAICompatibleTool` but flatter — `name`, `description`, and
 * `parameters` are top-level fields, not nested under `function`.
 */
export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * Discriminated union of `/v1/responses` streaming events. The spike
 * confirmed the server emits these as SSE `event:` + `data:` pairs
 * (two-line protocol, distinct from `/chat/completions` single-line
 * `data:` chunks). Termination is `response.completed` — there is NO
 * `data: [DONE]` marker.
 */
export type ResponsesStreamEvent =
  | { type: 'response.created'; response: ResponsesResponseObject }
  | { type: 'response.in_progress'; response: ResponsesResponseObject }
  | {
      type: 'response.output_item.added';
      item: ResponsesOutputItem;
      output_index: number;
    }
  | {
      type: 'response.output_item.done';
      item: ResponsesOutputItem;
      output_index: number;
    }
  | {
      type: 'response.reasoning_summary_text.delta';
      delta: string;
      item_id: string;
    }
  | { type: 'response.output_text.delta'; delta: string; item_id: string }
  | { type: 'response.completed'; response: ResponsesResponseObject }
  | { type: 'response.failed'; response: ResponsesResponseObject }
  | { type: 'response.incomplete'; response: ResponsesResponseObject };

/**
 * The `response` object carried by lifecycle events. `output` is
 * populated on `response.completed` (and partially on `in_progress`).
 * `usage` is populated only on `completed`. `error` is populated on
 * `failed` and `incomplete`.
 */
export interface ResponsesResponseObject {
  id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete';
  model: string;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; type: string } | null;
}

/**
 * A single item in the response `output[]` array. Discriminated by
 * `type`: `reasoning` (thinking summary), `message` (assistant text),
 * `function_call` (tool invocation). The spike confirmed all three
 * variants appear in the stream via `response.output_item.added` /
 * `response.output_item.done` events.
 */
export type ResponsesOutputItem =
  | {
      id: string;
      type: 'reasoning';
      summary?: Array<{ type: string; text: string }>;
    }
  | {
      id: string;
      type: 'message';
      role: string;
      content: Array<{ type: string; text: string }>;
    }
  | {
      id: string;
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      status?: string;
    };
