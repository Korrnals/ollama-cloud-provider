import * as vscode from 'vscode';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  OpenAIContentPart,
} from './protocolTypes.js';

/**
 * Returns true when the message's content array contains at least one
 * `vscode.LanguageModelDataPart` with an `image/*` mime type. Used by
 * the provider to detect image-bearing requests and reject them when
 * the selected model does not support vision.
 *
 * The duck-typing fallback mirrors the canonical `LanguageModelDataPart`
 * shape so the stub-based tests can construct data parts without a real
 * `vscode.LanguageModelDataPart` constructor.
 */
export function hasImageParts(
  content: readonly unknown[],
): boolean {
  return content.some(isImageDataPart);
}

/**
 * Returns true if `part` is an `image/*` data part — either a real
 * `vscode.LanguageModelDataPart` or a duck-typed object with `mimeType`
 * (string starting with `image/`) and `data` (Uint8Array).
 */
export function isImageDataPart(
  part: unknown,
): boolean {
  return isDataPart(part) && part.mimeType.toLowerCase().startsWith('image/');
}

function isDataPart(
  part: unknown,
): part is vscode.LanguageModelDataPart {
  if (part instanceof vscode.LanguageModelDataPart) {
    return true;
  }
  if (!part || typeof part !== 'object') {
    return false;
  }
  const candidate = part as { mimeType?: unknown; data?: unknown };
  return (
    typeof candidate.mimeType === 'string' &&
    candidate.data instanceof Uint8Array
  );
}

/**
 * Converts a `LanguageModelDataPart` (image) to a `data:` URL — the
 * form the OpenAI-compatible chat completions endpoint expects in the
 * `image_url.url` field. The base64 encoding is deterministic and
 * synchronous; large images still go through `Buffer.from(...).toString('base64')`.
 */
export function toDataUrl(part: vscode.LanguageModelDataPart): string {
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

export function convertMessagesToOpenAI(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): OpenAICompatibleMessage[] {
  const result: OpenAICompatibleMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
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
          content: serializeToolResultContent(part.content),
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

function mapRole(
  role: vscode.LanguageModelChatMessageRole,
): 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }

  return 'user';
}

function serializeToolResultContent(parts: readonly unknown[]): string {
  const text = extractText(parts);
  return text || JSON.stringify(parts);
}

function extractText(parts: readonly unknown[]): string {
  let text = '';

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }

  return text;
}
