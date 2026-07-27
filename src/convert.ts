import * as vscode from 'vscode';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  OpenAIContentPart,
} from './protocolTypes.js';
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
