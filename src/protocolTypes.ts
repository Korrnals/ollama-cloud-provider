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
