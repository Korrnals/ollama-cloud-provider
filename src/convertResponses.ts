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

// Re-exported so callers can import the vision gate helper from this
// module alongside the converters.
export { hasImageParts };

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
