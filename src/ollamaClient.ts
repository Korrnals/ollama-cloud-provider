import type { CancellationToken } from 'vscode';
import { logger } from './logger.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAICompatibleToolCall,
  StreamCallbacks,
  UsageInfo,
} from './protocolTypes.js';

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
}

export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async streamChat(
    request: {
      model: string;
      messages: OpenAICompatibleMessage[];
      tools?: OpenAICompatibleTool[];
      tool_choice?: 'auto' | 'required' | 'none';
      extraBody?: Record<string, unknown>;
    },
    callbacks: StreamCallbacks,
    cancellationToken?: CancellationToken,
  ): Promise<void> {
    const controller = new AbortController();
    const cancelListener = cancellationToken?.onCancellationRequested(() =>
      controller.abort(),
    );
    let done = false;

    try {
      const { extraBody, ...baseRequest } = request;
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          ...baseRequest,
          ...extraBody,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await extractErrorMessage(response));
      }
      if (!response.body) {
        throw new Error('Ollama Cloud returned no response body.');
      }

      const pendingToolCalls = new Map<number, OpenAICompatibleToolCall>();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (cancellationToken?.isCancellationRequested) {
          controller.abort();
          break;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const stop = processLine(line, pendingToolCalls, callbacks);
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
            const stop = processLine(line, pendingToolCalls, callbacks);
            if (stop) {
              done = true;
              break;
            }
          }
        }
      }

      if (!done) {
        flushToolCalls(pendingToolCalls, callbacks);
        callbacks.onDone();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        callbacks.onDone();
        return;
      }
      callbacks.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      cancelListener?.dispose();
    }
  }
}

function processLine(
  line: string,
  pendingToolCalls: Map<number, OpenAICompatibleToolCall>,
  callbacks: StreamCallbacks,
): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) {
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
    logger.warn(
      'Failed to parse Ollama Cloud SSE payload.',
      json.slice(0, 200),
      error,
    );
    return false;
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

async function extractErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed.error?.message || parsed.message || `HTTP ${response.status}`;
  } catch {
    return body || `HTTP ${response.status}`;
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
  } catch {
    logger.warn('Failed to parse tool input JSON.', value.slice(0, 200));
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
