import * as vscode from 'vscode';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  OpenAIContentPart,
  NativeChatMessage,
  NativeChatTool,
  NativeChatToolCall,
} from './protocolTypes.js';
import { logger } from './logger.js';
// ADR 0006 — shared primitives now live in `convertPrimitives.ts` so
// both the `/chat/completions` converter and the `/v1/responses`
// converter use the same security-sensitive helpers (image detection,
// data-URL encoding, tool-result serialization). Re-exported below for
// backward compatibility — existing imports from `./convert.js` keep
// working and the 322-test regression suite is untouched.
import {
  hasImageParts as sharedHasImageParts,
  isImageDataPart as sharedIsImageDataPart,
  toDataUrl as sharedToDataUrl,
  serializeToolResultContent as sharedSerializeToolResultContent,
  mapRole as sharedMapRole,
} from './convertPrimitives.js';

// Backward-compatibility re-exports — existing imports from
// `./convert.js` keep working; the 322-test regression suite is
// untouched. The canonical implementations live in
// `convertPrimitives.ts` and are shared with `convertResponses.ts`.
export const hasImageParts = sharedHasImageParts;
export const isImageDataPart = sharedIsImageDataPart;
export const toDataUrl = sharedToDataUrl;

export function convertMessagesToOpenAI(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): OpenAICompatibleMessage[] {
  const result: OpenAICompatibleMessage[] = [];

  for (const message of messages) {
    const role = sharedMapRole(message.role);
    let text = '';
    const imageParts: OpenAIContentPart[] = [];
    const toolCalls: OpenAICompatibleToolCall[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          callId: part.callId,
          content: sharedSerializeToolResultContent(part.content),
        });
      }

      // Vision — collect image parts. They are emitted into the
      // user message's `content` array only (assistant/tool messages
      // stay text-only). The provider's vision gate rejects images
      // for text-only models BEFORE this function is reached.
      if (isImageDataPart(part) && role === 'user') {
        imageParts.push({
          type: 'image_url',
          image_url: { url: toDataUrl(part as vscode.LanguageModelDataPart) },
        });
      }
    }

    if (role === 'assistant') {
      if (text || toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: text || '',
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else {
        // Issue #41 — Strand 3.1 audit / Strand 1 diagnostic: an
        // assistant message with no text AND no tool calls is silently
        // dropped. That is the correct behaviour (empty assistant
        // turns would break the OpenAI `messages[]` shape), but it is
        // also a signal worth surfacing — a chat client that emits
        // empty assistant turns may be losing reasoning content.
        // v0.11.0 Task 1 — DEBUG, not INFO: this fires once per empty
        // message in every multi-turn conversation and drowns the log.
        logger.debug(
          `convert: dropped empty assistant message (role=assistant, parts=${message.content.length})`,
        );
      }
    } else if (imageParts.length > 0) {
      // User message with images: content becomes an array of text +
      // image parts. If there is no text, emit a single empty text
      // part so the message is not empty (OpenAI requires content).
      const parts: OpenAIContentPart[] = [];
      if (text) {
        parts.push({ type: 'text', text });
      }
      parts.push(...imageParts);
      result.push({ role, content: parts });
    } else if (text) {
      result.push({ role, content: text });
    } else {
      // Issue #41 — Strand 3.1 audit / Strand 1 diagnostic: a user
      // or system message with no text and no images is dropped.
      // Correct behaviour (OpenAI rejects empty `content`), but a
      // signal worth surfacing — a chat client emitting empty user
      // turns is likely a bug. Tool messages are exempt: they are
      // emitted above from `toolResults` regardless of `text`.
      // v0.11.0 Task 1 — DEBUG, not INFO: see note above (fires per
      // empty message in every multi-turn conversation).
      logger.debug(
        `convert: dropped empty ${role} message (parts=${message.content.length})`,
      );
    }

    for (const toolResult of toolResults) {
      result.push({
        role: 'tool',
        content: toolResult.content,
        tool_call_id: toolResult.callId,
      });
    }
  }

  return result;
}

export function convertToolsToOpenAI(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): OpenAICompatibleTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined,
    },
  }));
}

export function getMessageText(
  text: string | vscode.LanguageModelChatRequestMessage,
): string {
  if (typeof text === 'string') {
    return text;
  }

  let result = '';
  for (const part of text.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      result += part.value;
    }
  }
  return result;
}

export function countOpenAIRequestChars(
  messages: readonly OpenAICompatibleMessage[],
): number {
  let total = 0;

  for (const message of messages) {
    total += contentLength(message.content);
    total += message.tool_call_id?.length ?? 0;

    for (const toolCall of message.tool_calls ?? []) {
      total += toolCall.id.length;
      total += toolCall.function.name.length;
      total += toolCall.function.arguments.length;
    }
  }

  return total;
}

/**
 * Returns the character length of an `OpenAIChatContent` value. For a
 * string, returns its length. For an array of parts, sums the lengths
 * of each part's text or image_url.url field. For `null`, returns 0.
 *
 * The image URL includes the full base64 payload — counting its length
 * gives a conservative (high) estimate of the request size, which is
 * what the token estimator wants (images cost many tokens).
 */
function contentLength(content: OpenAICompatibleMessage['content']): number {
  if (content === null || content === undefined) {
    return 0;
  }
  if (typeof content === 'string') {
    return content.length;
  }
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') {
      total += part.text.length;
    } else {
      total += part.image_url.url.length;
    }
  }
  return total;
}

// The local `mapRole` and `serializeToolResultContent` helpers were
// moved to `convertPrimitives.ts` (ADR 0006) so the `/v1/responses`
// converter shares the same security-sensitive logic. The shared
// helpers are imported above as `sharedMapRole` /
// `sharedSerializeToolResultContent` and called directly from
// `convertMessagesToOpenAI`. No local duplicates remain.

// ---------------------------------------------------------------------------
// Phase 1 (2026-08-03 endpoint routing) — native `/api/chat` conversion.
//
// Native Ollama `/api/chat` uses a DIFFERENT message shape than the
// OpenAI-compat `/chat/completions`:
//   - Vision images are a top-level `images: ["base64..."]` array on the
//     user message (NOT `image_url` content parts).
//   - `tool_calls[].function.arguments` is an OBJECT (not a JSON string).
//   - `tools[].function.parameters` is the same shape as compat.
//
// `convertMessagesToNative` produces `NativeChatMessage[]`; the
// `OllamaClient` native path serialises them verbatim. The converter
// reuses the shared security-sensitive helpers (`sharedMapRole`,
// `sharedSerializeToolResultContent`, `sharedIsImageDataPart`) so the
// native path inherits the same image-detection and tool-result
// serialization guarantees as the compat path.
// ---------------------------------------------------------------------------

/**
 * Phase 1 — converts a `LanguageModelDataPart` (image) to the RAW
 * base64 string native `/api/chat` expects in the `images[]` array
 * (no `data:` URL prefix). The compat path uses `toDataUrl` (full
 * `data:` URL); native wants bare base64.
 */
function toNativeImageBase64(part: vscode.LanguageModelDataPart): string {
  return Buffer.from(part.data).toString('base64');
}

/**
 * Phase 1 — converts VS Code chat messages to the native `/api/chat`
 * message schema.
 *
 * Differences from `convertMessagesToOpenAI`:
 *   - `content` is always a STRING (native does not use content-part
 *     arrays — images go in `images`).
 *   - Vision images are collected into a top-level `images: ["base64..."]`
 *     array on the user message (not `image_url` content parts).
 *   - `tool_calls[].function.arguments` is an OBJECT (not a JSON
 *     string) — the native endpoint accepts object arguments directly.
 *   - Tool results emit a `role: 'tool'` message with `content` and
 *     `tool_call_id` (same shape as compat, just string content).
 *
 * Empty assistant messages (no text AND no tool calls) are dropped,
 * mirroring the compat converter (an empty assistant turn would break
 * the `messages[]` shape).
 *
 * Empty user/system messages (no text AND no images) are dropped —
 * EXCEPT when they carry tool results. VS Code delivers tool results
 * as user-role messages, so a tool-result-only user message must NOT
 * be dropped: its (empty) user entry is skipped (native rejects empty
 * content) and the tool results are emitted after the role chain as
 * `role: 'tool'` messages — mirroring the compat converter contract:
 * tool results survive even when the host message is empty.
 */
export function convertMessagesToNative(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): NativeChatMessage[] {
  const result: NativeChatMessage[] = [];

  for (const message of messages) {
    const role = sharedMapRole(message.role);
    let text = '';
    const images: string[] = [];
    const toolCalls: NativeChatToolCall[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments:
              (part.input as Record<string, unknown> | undefined) ?? {},
          },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          callId: part.callId,
          content: sharedSerializeToolResultContent(part.content),
        });
      }

      // Vision — collect image parts into the user message's `images`
      // array (native schema). Assistant/tool messages stay text-only.
      // The provider's vision gate rejects images for text-only models
      // BEFORE this function is reached.
      if (sharedIsImageDataPart(part) && role === 'user') {
        images.push(toNativeImageBase64(part as vscode.LanguageModelDataPart));
      }
    }

    if (role === 'assistant') {
      if (text || toolCalls.length > 0) {
        const entry: NativeChatMessage = {
          role: 'assistant',
          content: text || '',
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
        result.push(entry);
      } else {
        // Mirror the compat converter: drop empty assistant turns.
        // v0.11.0 Task 1 — DEBUG for parity with the compat converter.
        logger.debug(
          `convertNative: dropped empty assistant message (role=assistant, parts=${message.content.length})`,
        );
      }
    } else if (role === 'user' || role === 'system') {
      const entry: NativeChatMessage = { role, content: text };
      if (images.length > 0) {
        entry.images = images;
      }
      // Drop empty user/system messages (native rejects empty content),
      // but keep a user message that has images even with empty text —
      // native accepts `content: ""` + `images: [...]`.
      if (!text && images.length === 0) {
        if (toolResults.length === 0) {
          // v0.11.0 Task 1 — DEBUG for parity with the compat converter.
          logger.debug(
            `convertNative: dropped empty ${role} message (parts=${message.content.length})`,
          );
          continue;
        }
        // Tool-result-only user message (P0 fix): do NOT push an empty
        // user entry (native rejects empty content) and do NOT drop the
        // message — the tool results are emitted after the if/else
        // chain below, mirroring the compat converter contract: tool
        // results survive even when the host message is empty.
      } else {
        result.push(entry);
      }
    } else {
      // tool role — emitted below from toolResults.
      if (text) {
        result.push({ role: 'tool', content: text });
      }
    }

    for (const toolResult of toolResults) {
      result.push({
        role: 'tool',
        content: toolResult.content,
        tool_call_id: toolResult.callId,
      });
    }
  }

  return result;
}

/**
 * Phase 1 — converts VS Code chat tools to the native `/api/chat` tool
 * schema. Same shape as `convertToolsToOpenAI` (kept as a separate
 * function so the two wire formats stay separable; the types are
 * distinct — `NativeChatTool` vs `OpenAICompatibleTool`).
 */
export function convertToolsToNative(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): NativeChatTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined,
    },
  }));
}

// ---------------------------------------------------------------------------
// ADR 0007 — context-filter-aware native `/api/chat` conversion.
//
// `convertMessagesToNative` (above) consumes VS Code
// `LanguageModelChatRequestMessage[]` directly — the original source of
// the request. When the context filter runs at `safe`/`aggressive`, the
// filter operates on `OpenAICompatibleMessage[]` (the `/chat/completions`
// shape) and produces a filtered array. The native path — the DEFAULT
// endpoint for cloud (`auto` → native) — must consume the FILTERED
// payload too, or the filter silently does nothing for default users.
// This converter shapes the filtered `OpenAICompatibleMessage[]`
// directly into the native `/api/chat` `messages[]` form without a
// VS Code ↔ OpenAI round-trip, mirroring
// `convertOpenAIMessagesToResponsesInput` for `/v1/responses`.
//
// Mapping differences from `convertOpenAIMessagesToResponsesInput`:
//   - NO `instructions` hoist — native has no top-level instructions
//     field, so system messages stay in place (native accepts multiple
//     system messages, unlike `/v1/responses`).
//   - `tool_calls[].function.arguments` is parsed from its JSON STRING
//     into an OBJECT (native contract; the OpenAI shape carries a
//     string). Parse failure → `{}` so a malformed argument string
//     never breaks the request.
//   - `role:'tool'` messages emit a native `tool` message (native HAS
//     a tool role, unlike `/v1/responses`' `function_call_output`
//     items) and are ALWAYS emitted — tool-call integrity (P0 lesson):
//     tool results survive regardless of host-message emptiness; the
//     filter may legitimately produce them from integrity enforcement.
// ---------------------------------------------------------------------------

/**
 * ADR 0007 — converts filtered `OpenAICompatibleMessage[]` (the output
 * of `filterContext`) into the native `/api/chat` message schema.
 * Used by the provider when the context filter ran at
 * `safe`/`aggressive` AND the selected endpoint is native `/api/chat`
 * — so the filtered payload reaches all three endpoints without a
 * VS Code ↔ OpenAI round-trip. See ADR 0007 § Provider integration
 * point.
 *
 * Role mapping:
 *   - `system` → `{ role:'system', content }` kept IN PLACE (no
 *     `instructions` hoist — native accepts multiple system messages);
 *     empty content is dropped.
 *   - `user` → `{ role:'user', content }`; part-array content keeps
 *     `text` parts, image parts are skipped (defence-in-depth — vision
 *     content never reaches this path: the vision gate routes image
 *     requests before the filter). Empty text is dropped (mirrors
 *     `convertMessagesToNative`).
 *   - `assistant` → `{ role:'assistant', content, tool_calls? ,
 *     reasoning_content? }`; `tool_calls[].function.arguments` is
 *     `JSON.parse`d into an object (failure → `{}`). An assistant with
 *     no text AND no tool calls is dropped (mirrors
 *     `convertMessagesToNative`).
 *   - `tool` → `{ role:'tool', content, tool_call_id? }` — ALWAYS
 *     emitted, even with empty content (P0 tool-call-integrity
 *     lesson: tool results survive regardless).
 *
 * Pure + stateless — same contract as `convertMessagesToNative`.
 */
export function convertOpenAIMessagesToNative(
  messages: readonly OpenAICompatibleMessage[],
): NativeChatMessage[] {
  const result: NativeChatMessage[] = [];

  for (const message of messages) {
    const role = message.role;

    if (role === 'tool') {
      // ALWAYS emit — tool-call integrity (P0 lesson): tool results
      // survive regardless of emptiness; the filter may legitimately
      // produce them from integrity enforcement.
      result.push({
        role: 'tool',
        content: openAIContentToNativeText(message.content),
        ...(message.tool_call_id !== undefined
          ? { tool_call_id: message.tool_call_id }
          : {}),
      });
      continue;
    }

    const text = openAIContentToNativeText(message.content);

    if (role === 'assistant') {
      if (text || (message.tool_calls !== undefined && message.tool_calls.length > 0)) {
        result.push({
          role: 'assistant',
          content: text || '',
          ...(message.tool_calls !== undefined && message.tool_calls.length > 0
            ? { tool_calls: convertToolCallsToNative(message.tool_calls) }
            : {}),
          ...(message.reasoning_content !== undefined
            ? { reasoning_content: message.reasoning_content }
            : {}),
        });
      } else {
        // Mirror `convertMessagesToNative`: drop empty assistant turns.
        logger.debug(
          'convertOpenAIToNative: dropped empty assistant message after context filter',
        );
      }
      continue;
    }

    // system | user — NO instructions hoist: native has no top-level
    // instructions field, so system messages stay in place (first one
    // included, and a second system message after filtering stays too
    // — native accepts multiple system messages, unlike /v1/responses).
    // Empty text after filtering is dropped — mirrors the VS Code-path
    // guard in `convertMessagesToNative` (v0.12.0 review P2 fix; the
    // filter already guarantees non-empty user/system messages, this
    // is defence-in-depth for raw payloads).
    if (text) {
      result.push({ role, content: text });
    } else {
      logger.debug(
        'convertOpenAIToNative: dropped empty user/system message after context filter',
      );
    }
  }

  return result;
}

/**
 * ADR 0007 — extracts the native text from a filtered message's
 * `OpenAIChatContent`: string → itself; null/undefined → ""; part
 * array → concatenated `text` parts. `image_url` parts are SKIPPED
 * with a debug log — vision content never reaches this path by design
 * (the vision gate routes image requests before the filter), so the
 * log is defence-in-depth only.
 */
function openAIContentToNativeText(
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
    } else {
      logger.debug(
        'convertOpenAIToNative: dropped image part after context filter',
      );
    }
  }
  return text;
}

/**
 * ADR 0007 — maps an OpenAI tool-call list (JSON-string arguments)
 * onto the native shape (object arguments).
 */
function convertToolCallsToNative(
  calls: readonly OpenAICompatibleToolCall[],
): NativeChatToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.function.name,
      arguments: parseNativeArguments(call.function.arguments),
    },
  }));
}

/**
 * ADR 0007 — parses a tool-call arguments JSON string into the object
 * native `/api/chat` requires. Parse failure (or a non-object result)
 * → `{}` — an unparseable argument string must not break the request;
 * native receives an empty object instead.
 */
function parseNativeArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * ADR 0007 — context-filter-aware tool conversion for native
 * `/api/chat`. Mirrors `convertToolsToNative` but reads the
 * OpenAI-compatible tool shape (`OpenAICompatibleTool`, the
 * post-filter form) instead of VS Code's `LanguageModelChatTool[]`,
 * symmetric with `convertOpenAIToolsToResponses` for `/v1/responses`.
 *
 * Returns `undefined` when the tool list is empty so the request body
 * omits the `tools` field entirely (same contract as
 * `convertToolsToNative`).
 */
export function convertOpenAIToolsToNative(
  tools: readonly OpenAICompatibleTool[] | undefined,
): NativeChatTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

// NOTE: `convertToolsToResponses` lives in `convertResponses.ts`
// (flat `/v1/responses` tool schema) — do NOT re-add it here.

