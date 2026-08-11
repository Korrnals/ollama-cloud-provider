// ADR 0006 — `/v1/responses` request converter.
//
// Mirrors `convert.ts` (the `/chat/completions` converter) but emits
// the typed `input[]` array the `/v1/responses` endpoint expects
// instead of the `messages[]` array. The two share security-sensitive
// primitives (image detection, data-URL encoding, tool-result
// serialization, role mapping) via `convertPrimitives.ts`.
//
// Per ADR 0006 the converter is stateless and free of side effects.
// The provider decides which endpoint to call (using the capability
// cache + `preferredEndpoint`); this module only shapes the request.
import * as vscode from 'vscode';
import type {
  OpenAICompatibleTool,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesTool,
} from './protocolTypes.js';
import {
  hasImageParts,
  isImageDataPart,
  toDataUrl,
  serializeToolResultContent,
  mapRole,
} from './convertPrimitives.js';
import { logger } from './logger.js';

/**
 * Result of converting VS Code messages to a `/v1/responses` request
 * body. The first `role:system` message is hoisted to top-level
 * `instructions`; the remaining messages become `input[]`.
 */
export interface ResponsesConversionResult {
  input: ResponsesInputItem[];
  instructions?: string;
}

/**
 * Converts a list of VS Code chat request messages to the
 * `/v1/responses` `input[]` shape.
 *
 * - The FIRST `role:system` message is hoisted to the top-level
 *   `instructions` field. Subsequent `role:system` messages are
 *   dropped (OpenAI ignores extra system messages in `input[]`).
 * - User messages become `{ type:'message', role:'user', content[] }`
 *   with `input_text` parts and — when image parts are present —
 *   `input_image` parts carrying the data URL. Mirrors the
 *   `/chat/completions` vision path so the same vision gate and
 *   token accounting apply.
 * - Assistant messages become `{ type:'message', role:'assistant',
 *   content[] }` with `output_text` parts.
 * - Assistant tool calls (`LanguageModelToolCallPart`) become
 *   top-level `{ type:'function_call', call_id, name, arguments }`
 *   input items — NOT content parts inside a message. This matches
 *   the OpenAI Responses API spec where function calls are
 *   first-class input items.
 * - Tool results (`LanguageModelToolResultPart`) become top-level
 *   `{ type:'function_call_output', call_id, output }` input items,
 *   NOT content parts inside a message. The v0.6.0 release
 *   incorrectly wrapped them as `tool_call_output` content parts
 *   inside a `role:'user'` message, which the server rejected with
 *   `unknown content type: tool_call_output`.
 */
export function convertToResponsesInput(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): ResponsesConversionResult {
  const input: ResponsesInputItem[] = [];
  let instructions: string | undefined;

  for (const message of messages) {
    const role = mapRole(message.role);

    if (role === 'system') {
      if (instructions === undefined) {
        instructions = extractMessageText(message);
      } else {
        // Issue #41 — Strand 3.1 audit / Strand 1 diagnostic: a
        // SECOND `role:system` message is dropped because OpenAI's
        // `/v1/responses` endpoint hoists only the first system message
        // to top-level `instructions`. Subsequent system messages are
        // NOT silently folded into `instructions` — they are discarded.
        // Surfacing this so a chat client that emits multiple system
        // turns is visible in the audit (their content is lost).
        logger.info(
          `convertResponses: dropped extra system message (parts=${message.content.length}, kept first as instructions)`,
        );
      }
      continue;
    }

    const contentParts: ResponsesContentPart[] = [];
    const toolCalls: Array<{ callId: string; name: string; arguments: string }> = [];
    const toolResults: Array<{ callId: string; output: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        contentParts.push(
          role === 'assistant'
            ? { type: 'output_text', text: part.value }
            : { type: 'input_text', text: part.value },
        );
      }

      // Vision — only user messages carry images (the vision gate
      // rejects images for text-only models BEFORE this function is
      // reached). Same rule as `convertMessagesToOpenAI`.
      if (isImageDataPart(part) && role === 'user') {
        contentParts.push({
          type: 'input_image',
          image_url: toDataUrl(part as vscode.LanguageModelDataPart),
        });
      }

      // Tool calls from the assistant — top-level `function_call`
      // input items (NOT content parts).
      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          callId: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
      }

      // Tool results — top-level `function_call_output` input
      // items (NOT content parts inside a message).
      if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          callId: part.callId,
          output: serializeToolResultContent(part.content),
        });
      }
    }

    // Emit the message item only when it has content (text/image).
    // Empty assistant messages with no tool calls are dropped,
    // mirroring `convertMessagesToOpenAI`.
    if (contentParts.length > 0) {
      input.push({ type: 'message', role, content: contentParts });
    } else if (role === 'assistant' && toolCalls.length === 0) {
      // Issue #41 — Strand 3.1 audit / Strand 1 diagnostic: empty
      // assistant turn with no text AND no tool calls is dropped.
      // Same signal as `convert.ts` — surface it so silent content
      // loss is visible.
      // v0.11.0 Task 1 — DEBUG for parity with convert.ts (fires per
      // empty message in every multi-turn conversation).
      logger.debug(
        `convertResponses: dropped empty assistant message (role=assistant, parts=${message.content.length})`,
      );
    }

    // Emit `function_call` items for assistant tool calls. These
    // are top-level input items, emitted AFTER the assistant's
    // text message (matching conversation order).
    for (const toolCall of toolCalls) {
      input.push({
        type: 'function_call',
        call_id: toolCall.callId,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
    }

    // Emit `function_call_output` items for tool results. These
    // are top-level input items, NOT content parts inside a message.
    for (const toolResult of toolResults) {
      input.push({
        type: 'function_call_output',
        call_id: toolResult.callId,
        output: toolResult.output,
      });
    }
  }

  return instructions !== undefined ? { input, instructions } : { input };
}

/**
 * Converts VS Code tool definitions to the `/v1/responses` tool
 * schema. Same logical schema as `convertToolsToOpenAI` but flatter —
 * `name`, `description`, `parameters` are top-level fields, not
 * nested under `function`.
 *
 * Returns `undefined` when the tool list is empty so the request body
 * omits the `tools` field entirely.
 */
export function convertToolsToResponses(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: (tool.inputSchema as Record<string, unknown>) ?? {},
  }));
}

/**
 * ADR 0007 — context-filter-aware tool conversion for `/v1/responses`.
 *
 * Mirrors `convertToolsToResponses` but reads the OpenAI-compatible
 * tool shape (`OpenAICompatibleTool`, the `/chat/completions` form
 * with `function.{name,description,parameters}` nesting) instead of
 * VS Code's `LanguageModelChatTool[]`. Used when the context filter
 * ran at `safe`/`aggressive` and produced a filtered
 * `OpenAICompatibleTool[]` (e.g. with duplicate `function.name`
 * entries removed). Keeps the `/v1/responses` path on the FILTERED
 * payload without a VS Code ↔ OpenAI round-trip, symmetric with
 * `convertOpenAIMessagesToResponsesInput` for messages.
 *
 * Returns `undefined` when the tool list is empty so the request body
 * omits the `tools` field entirely (same contract as
 * `convertToolsToResponses`).
 */
export function convertOpenAIToolsToResponses(
  tools: readonly OpenAICompatibleTool[] | undefined,
): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? {},
  }));
}

// Re-exported so callers can import the vision gate helper from this
// module alongside the converters.
export { hasImageParts };

// ---------------------------------------------------------------------------
// ADR 0007 — context-filter-aware `/v1/responses` conversion.
//
// `convertToResponsesInput` (above) consumes VS Code
// `LanguageModelChatRequestMessage[]` directly — the original source of
// the request. When the context filter (ADR 0007) runs at `safe` or
// `aggressive`, the filter operates on `OpenAICompatibleMessage[]`
// (the `/chat/completions` shape) and produces a filtered array. The
// `/v1/responses` path needs the FILTERED payload too, but converting
// the filtered OpenAI messages back to VS Code messages (then back to
// `/v1/responses`) would be a lossy round-trip. Instead, this helper
// shapes the filtered `OpenAICompatibleMessage[]` directly into the
// `/v1/responses` `input[]` + `instructions` form — the same shape
// `convertToResponsesInput` produces, but reading OpenAI-format
// messages instead of VS Code messages.
//
// The mapping mirrors `convertToResponsesInput`:
//   - First `role:system` message → top-level `instructions`.
//   - Subsequent `role:system` messages → dropped (logged, same as
//     `convertToResponsesInput`).
//   - User/assistant messages with text → `{ type:'message', role,
//     content[] }` with `input_text` (user) or `output_text`
//     (assistant) parts.
//   - `image_url` parts (vision) → `input_image` parts carrying the
//     data URL. Vision content is never filtered (ADR § Non-goals), so
//     it passes through this helper unchanged.
//   - Assistant `tool_calls` → top-level `function_call` items.
//   - `role:tool` messages (tool results) → top-level
//     `function_call_output` items.
//
// Pure + stateless — same contract as `convertToResponsesInput`.
// ---------------------------------------------------------------------------

import type {
  OpenAICompatibleMessage,
  OpenAIContentPart,
} from './protocolTypes.js';

/**
 * Converts filtered `OpenAICompatibleMessage[]` (the output of
 * `filterContext`) into the `/v1/responses` `input[]` + `instructions`
 * shape. Used by the provider when the context filter ran at
 * `safe`/`aggressive` AND the selected endpoint is `/v1/responses` —
 * so the filtered payload reaches both endpoints without a VS Code ↔
 * OpenAI round-trip. See ADR 0007 § Provider integration point.
 */
export function convertOpenAIMessagesToResponsesInput(
  messages: readonly OpenAICompatibleMessage[],
): ResponsesConversionResult {
  const input: ResponsesInputItem[] = [];
  let instructions: string | undefined;

  for (const message of messages) {
    const role = message.role;

    if (role === 'system') {
      if (instructions === undefined) {
        instructions = openAIContentToText(message.content);
      } else {
        // Same diagnostic as `convertToResponsesInput`: a second
        // `role:system` message is dropped because `/v1/responses`
        // hoists only the first system message to `instructions`.
        logger.info(
          'convertResponses: dropped extra system message after context filter (kept first as instructions)',
        );
      }
      continue;
    }

    // Tool results (`role:tool`) → top-level `function_call_output`
    // items only (no message item — `/v1/responses` has no `tool`
    // message role). Skip the message-item emission below for tool.
    if (role === 'tool') {
      const output = openAIContentToText(message.content);
      if (message.tool_call_id !== undefined) {
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output,
        });
      }
      continue;
    }

    const contentParts = openAIContentToResponsesParts(message.content, role);

    // Emit the message item only when it has content. Empty assistant
    // messages with no tool calls are dropped, mirroring
    // `convertToResponsesInput`. `role` is now narrowed to
    // `user` | `assistant` (system handled above, tool handled above).
    if (contentParts.length > 0) {
      input.push({ type: 'message', role, content: contentParts });
    } else if (role === 'assistant' && (message.tool_calls === undefined || message.tool_calls.length === 0)) {
      // v0.11.0 Task 1 — DEBUG for parity with the pre-filter drop
      // above (same signal, fires per filtered message).
      logger.debug(
        'convertResponses: dropped empty assistant message after context filter',
      );
    }

    // Assistant tool calls → top-level `function_call` items.
    if (message.tool_calls !== undefined) {
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    }
  }

  return instructions !== undefined ? { input, instructions } : { input };
}

/**
 * Extracts the concatenated text from an `OpenAIChatContent` value
 * (string → itself; part array → concatenated `text` parts; null → "").
 * Used for the hoisted `instructions` and for `function_call_output`
 * `output` fields.
 */
function openAIContentToText(
  content: OpenAICompatibleMessage['content'],
): string {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  let text = '';
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

/**
 * Converts an `OpenAIChatContent` value into the `/v1/responses`
 * `content[]` part array. `text` parts → `input_text` (user) or
 * `output_text` (assistant); `image_url` parts → `input_image` with
 * the same data URL. Vision content passes through unchanged.
 */
function openAIContentToResponsesParts(
  content: OpenAICompatibleMessage['content'],
  role: 'system' | 'user' | 'assistant' | 'tool',
): ResponsesContentPart[] {
  const parts: ResponsesContentPart[] = [];
  if (content === null || content === undefined) {
    return parts;
  }
  if (typeof content === 'string') {
    if (content.length > 0) {
      parts.push(
        role === 'assistant'
          ? { type: 'output_text', text: content }
          : { type: 'input_text', text: content },
      );
    }
    return parts;
  }
  for (const part of content as OpenAIContentPart[]) {
    if (part.type === 'text') {
      if (part.text.length > 0) {
        parts.push(
          role === 'assistant'
            ? { type: 'output_text', text: part.text }
            : { type: 'input_text', text: part.text },
        );
      }
    } else if (part.type === 'image_url') {
      parts.push({
        type: 'input_image',
        image_url: part.image_url.url,
      });
    }
  }
  return parts;
}

function extractMessageText(
  message: vscode.LanguageModelChatRequestMessage,
): string {
  let text = '';
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}
