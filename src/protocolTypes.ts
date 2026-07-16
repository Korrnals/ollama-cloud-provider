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

export interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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
