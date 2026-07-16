import * as vscode from 'vscode';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
} from './protocolTypes.js';

export function convertMessagesToOpenAI(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): OpenAICompatibleMessage[] {
  const result: OpenAICompatibleMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
    let text = '';
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
    }

    if (role === 'assistant') {
      if (text || toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: text || '',
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
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
    total += message.content?.length ?? 0;
    total += message.tool_call_id?.length ?? 0;

    for (const toolCall of message.tool_calls ?? []) {
      total += toolCall.id.length;
      total += toolCall.function.name.length;
      total += toolCall.function.arguments.length;
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
