import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  convertToResponsesInput,
  convertOpenAIMessagesToResponsesInput,
  convertToolsToResponses,
} from '../../src/convertResponses.js';
import type {
  OpenAIChatContent,
  OpenAICompatibleMessage,
  OpenAICompatibleToolCall,
  ResponsesInputItem,
} from '../../src/protocolTypes.js';

const { LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolResultPart, LanguageModelToolCallPart } =
  vscode;

function userMsg(...parts: unknown[]): vscode.LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: parts as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

function assistantMsg(...parts: unknown[]): vscode.LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.Assistant,
    content: parts as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

// The stub defines a `System` member (value 1) that the official
// `@types/vscode` enum does not declare. We cast through `unknown`
// so the test compiles against the real types while exercising the
// system-hoist path the stub enables.
function systemMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: 1 as unknown as vscode.LanguageModelChatMessageRole,
    content: [new LanguageModelTextPart(text)] as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

// Type-narrowing helper: asserts the item is a `message` and returns
// it with the `content` / `role` fields accessible. This is needed
// because `ResponsesInputItem` is now a discriminated union
// (`message` | `function_call` | `function_call_output`), not a
// single interface.
function asMessage(item: ResponsesInputItem): {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: Array<{ type: string; [key: string]: unknown }>;
} {
  assert.equal(item.type, 'message', `expected message, got ${item.type}`);
  return item as {
    type: 'message';
    role: 'user' | 'assistant' | 'system';
    content: Array<{ type: string; [key: string]: unknown }>;
  };
}

// Type-narrowing helpers for the top-level tool items
// (`function_call` / `function_call_output`), symmetric to `asMessage`.
function asFunctionCall(item: ResponsesInputItem): {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
} {
  assert.equal(item.type, 'function_call', `expected function_call, got ${item.type}`);
  return item as {
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
  };
}

function asFunctionCallOutput(item: ResponsesInputItem): {
  type: 'function_call_output';
  call_id: string;
  output: string;
} {
  assert.equal(item.type, 'function_call_output', `expected function_call_output, got ${item.type}`);
  return item as {
    type: 'function_call_output';
    call_id: string;
    output: string;
  };
}

describe('convertResponses.convertToResponsesInput', () => {
  it('maps a simple user text message to input[] with input_text', () => {
    const result = convertToResponsesInput([
      userMsg(new LanguageModelTextPart('hello')),
    ]);
    assert.equal(result.instructions, undefined);
    assert.equal(result.input.length, 1);
    const msg = asMessage(result.input[0]);
    assert.equal(msg.role, 'user');
    assert.deepEqual(msg.content, [
      { type: 'input_text', text: 'hello' },
    ]);
  });

  it('maps a user message with an image to input[] with input_image + data URL', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const image = new vscode.LanguageModelDataPart(bytes, 'image/png');
    const result = convertToResponsesInput([
      userMsg(new LanguageModelTextPart('describe this'), image),
    ]);
    assert.equal(result.input.length, 1);
    const content = asMessage(result.input[0]).content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'input_text');
    assert.equal(content[1].type, 'input_image');
    assert.match(
      (content[1] as unknown as { image_url: string }).image_url,
      /^data:image\/png;base64,AQIDBA==$/,
    );
  });

  it('hoists the first system message to instructions and drops it from input', () => {
    const result = convertToResponsesInput([
      systemMsg('you are a helpful assistant'),
      userMsg(new LanguageModelTextPart('hi')),
    ]);
    assert.equal(result.instructions, 'you are a helpful assistant');
    assert.equal(result.input.length, 1);
    assert.equal(asMessage(result.input[0]).role, 'user');
  });

  it('maps multiple messages to multiple input items in order', () => {
    const result = convertToResponsesInput([
      userMsg(new LanguageModelTextPart('question')),
      assistantMsg(new LanguageModelTextPart('answer')),
      userMsg(new LanguageModelTextPart('follow-up')),
    ]);
    assert.equal(result.input.length, 3);
    assert.equal(asMessage(result.input[0]).role, 'user');
    assert.equal(asMessage(result.input[1]).role, 'assistant');
    assert.equal(asMessage(result.input[2]).role, 'user');
    // Assistant messages use output_text, user messages use input_text.
    assert.equal(asMessage(result.input[1]).content[0].type, 'output_text');
    assert.equal(asMessage(result.input[2]).content[0].type, 'input_text');
  });

  it('emits a function_call_output top-level input item for a tool result', () => {
    const result = convertToResponsesInput([
      userMsg(
        new LanguageModelToolResultPart('call-1', [
          new LanguageModelTextPart('result text'),
        ]),
      ),
    ]);
    // Tool results are top-level `function_call_output` items, NOT
    // content parts inside a message. The v0.6.0 regression wrapped
    // them as `tool_call_output` content parts inside a `role:'user'`
    // message — the server rejected that with `unknown content type`.
    assert.equal(result.input.length, 1);
    assert.equal(result.input[0].type, 'function_call_output');
    assert.equal(
      (result.input[0] as { call_id: string }).call_id,
      'call-1',
    );
    assert.equal(
      (result.input[0] as { output: string }).output,
      'result text',
    );
  });

  it('emits a function_call top-level input item for an assistant tool call', () => {
    // Assistant tool calls must become top-level `function_call` input
    // items (NOT content parts). This was completely missing in v0.6.0
    // — `LanguageModelToolCallPart` was silently ignored by the
    // `/v1/responses` converter, breaking multi-turn tool-use.
    const toolCall = new LanguageModelToolCallPart(
      'call-42',
      'search',
      { query: 'hello' },
    );
    const result = convertToResponsesInput([
      assistantMsg(toolCall),
    ]);
    // Should be a `function_call` item, not a `message`.
    assert.equal(result.input.length, 1);
    assert.equal(result.input[0].type, 'function_call');
    assert.equal(
      (result.input[0] as { call_id: string }).call_id,
      'call-42',
    );
    assert.equal(
      (result.input[0] as { name: string }).name,
      'search',
    );
    assert.equal(
      (result.input[0] as { arguments: string }).arguments,
      '{"query":"hello"}',
    );
  });

  it('emits message + function_call items when assistant has text + tool call', () => {
    // An assistant message with both text and a tool call should
    // produce a `message` item (with output_text) followed by a
    // `function_call` item, preserving conversation order.
    const result = convertToResponsesInput([
      assistantMsg(
        new LanguageModelTextPart('Let me search for that.'),
        new LanguageModelToolCallPart('call-7', 'search', { q: 'test' }),
      ),
    ]);
    assert.equal(result.input.length, 2);
    assert.equal(result.input[0].type, 'message');
    assert.equal(asMessage(result.input[0]).role, 'assistant');
    assert.equal(result.input[1].type, 'function_call');
    assert.equal(
      (result.input[1] as { call_id: string }).call_id,
      'call-7',
    );
  });

  it('emits function_call_output items after the function_call in a tool-use round-trip', () => {
    // Full round-trip: assistant calls a tool, then the tool result
    // comes back. The order in `input[]` must be:
    //   1. function_call (the assistant's call)
    //   2. function_call_output (the tool result)
    const result = convertToResponsesInput([
      assistantMsg(
        new LanguageModelToolCallPart('call-99', 'calc', { x: 1 }),
      ),
      userMsg(
        new LanguageModelToolResultPart('call-99', [
          new LanguageModelTextPart('42'),
        ]),
      ),
    ]);
    assert.equal(result.input.length, 2);
    assert.equal(result.input[0].type, 'function_call');
    assert.equal(result.input[1].type, 'function_call_output');
    assert.equal(
      (result.input[1] as { call_id: string }).call_id,
      'call-99',
    );
    assert.equal(
      (result.input[1] as { output: string }).output,
      '42',
    );
  });
});

// --- OpenAI-format message fixtures for the filtered /v1/responses path ---
// These build `OpenAICompatibleMessage` (the /chat/completions shape the
// context filter produces) instead of VS Code messages, exercising
// `convertOpenAIMessagesToResponsesInput` directly without a round-trip.
function oaiSystem(content: string): OpenAICompatibleMessage {
  return { role: 'system', content };
}

function oaiUser(content: OpenAIChatContent): OpenAICompatibleMessage {
  return { role: 'user', content };
}

function oaiAssistant(opts: {
  content?: OpenAIChatContent;
  tool_calls?: OpenAICompatibleToolCall[];
}): OpenAICompatibleMessage {
  return {
    role: 'assistant',
    content: opts.content ?? null,
    tool_calls: opts.tool_calls,
  };
}

function oaiTool(toolCallId: string, content: string): OpenAICompatibleMessage {
  return { role: 'tool', content, tool_call_id: toolCallId };
}

describe('convertResponses.convertOpenAIMessagesToResponsesInput', () => {
  it('hoists the first filtered system message to instructions', () => {
    // A single `role:system` message becomes the top-level
    // `instructions`; it must NOT also appear in `input[]`.
    const result = convertOpenAIMessagesToResponsesInput([
      oaiSystem('you are a helpful assistant'),
      oaiUser('hi'),
    ]);
    assert.equal(result.instructions, 'you are a helpful assistant');
    assert.equal(result.input.length, 1);
    assert.equal(asMessage(result.input[0]).role, 'user');
  });

  it('drops subsequent system messages and keeps the first as instructions', () => {
    // `/v1/responses` hoists only the first system message to
    // `instructions`. A second system message is dropped (logged),
    // and the FIRST one wins — not the last.
    const result = convertOpenAIMessagesToResponsesInput([
      oaiSystem('first-wins'),
      oaiSystem('second-dropped'),
      oaiUser('hi'),
    ]);
    assert.equal(result.instructions, 'first-wins');
    // Both system messages are absent from `input[]`.
    assert.equal(result.input.length, 1);
    assert.equal(asMessage(result.input[0]).role, 'user');
  });

  it('preserves tool-call integrity: function_call + matching function_call_output', () => {
    // An assistant `tool_calls` entry plus a matching `role:tool`
    // result must produce a top-level `function_call` item AND a
    // top-level `function_call_output` item. Every `call_id` on a
    // `function_call` must have a matching `function_call_output` and
    // vice versa — tool-call integrity survives the conversion.
    const result = convertOpenAIMessagesToResponsesInput([
      oaiAssistant({
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' },
          },
        ],
      }),
      oaiTool('call-1', 'result text'),
    ]);
    assert.equal(result.input.length, 2);

    const call = asFunctionCall(result.input[0]);
    assert.equal(call.call_id, 'call-1');
    assert.equal(call.name, 'search');
    assert.equal(call.arguments, '{"q":"x"}');

    const output = asFunctionCallOutput(result.input[1]);
    assert.equal(output.call_id, 'call-1');
    assert.equal(output.output, 'result text');

    // Integrity check: call_ids match 1:1 across both item kinds.
    const callIds = result.input
      .filter((i) => i.type === 'function_call')
      .map((i) => (i as { call_id: string }).call_id);
    const outputIds = result.input
      .filter((i) => i.type === 'function_call_output')
      .map((i) => (i as { call_id: string }).call_id);
    assert.deepEqual(callIds, outputIds);
  });

  it('preserves a filtered vision image_url as an input_image part', () => {
    // Vision content is never filtered (ADR 0007 § Non-goals), so an
    // `image_url` content part must pass through as an `input_image`
    // part carrying the same data URL.
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const result = convertOpenAIMessagesToResponsesInput([
      oaiUser([
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]),
    ]);
    assert.equal(result.instructions, undefined);
    assert.equal(result.input.length, 1);
    const content = asMessage(result.input[0]).content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'input_text');
    assert.equal(content[1].type, 'input_image');
    assert.equal(
      (content[1] as unknown as { image_url: string }).image_url,
      dataUrl,
    );
  });

  it('drops an empty assistant message with no content and no tool calls', () => {
    // An assistant turn with neither text/image content nor tool calls
    // is dropped (not emitted as an empty item), mirroring
    // `convertToResponsesInput` and `convertMessagesToOpenAI`.
    const result = convertOpenAIMessagesToResponsesInput([
      oaiUser('question'),
      oaiAssistant({}),
      oaiUser('follow-up'),
    ]);
    assert.equal(result.input.length, 2);
    assert.equal(asMessage(result.input[0]).role, 'user');
    assert.equal(asMessage(result.input[1]).role, 'user');
  });

  it('converts a mixed conversation into instructions + ordered input items', () => {
    // A realistic filtered sequence (system + user + assistant-with-call
    // + tool + user) must produce `instructions` plus the right ordered
    // sequence of items: message(user) → message(assistant) →
    // function_call → function_call_output → message(user).
    const result = convertOpenAIMessagesToResponsesInput([
      oaiSystem('system prompt'),
      oaiUser('what is the weather'),
      oaiAssistant({
        content: 'let me check',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"NYC"}' },
          },
        ],
      }),
      oaiTool('c1', '72F sunny'),
      oaiUser('thanks'),
    ]);
    assert.equal(result.instructions, 'system prompt');
    assert.equal(result.input.length, 5);

    assert.equal(asMessage(result.input[0]).role, 'user');
    assert.equal(asMessage(result.input[1]).role, 'assistant');
    // Assistant text uses output_text.
    assert.equal(asMessage(result.input[1]).content[0].type, 'output_text');

    assert.equal(result.input[2].type, 'function_call');
    assert.equal(asFunctionCall(result.input[2]).call_id, 'c1');
    assert.equal(result.input[3].type, 'function_call_output');
    assert.equal(asFunctionCallOutput(result.input[3]).call_id, 'c1');

    assert.equal(asMessage(result.input[4]).role, 'user');
    assert.equal(asMessage(result.input[4]).content[0].type, 'input_text');
  });
});

describe('convertResponses.convertToolsToResponses', () => {
  it('returns undefined for empty tools', () => {
    assert.equal(convertToolsToResponses([]), undefined);
    assert.equal(convertToolsToResponses(undefined), undefined);
  });

  it('maps a tool to the flat /v1/responses function schema', () => {
    const tools: vscode.LanguageModelChatTool[] = [
      {
        name: 'search',
        description: 'search the web',
        inputSchema: { type: 'object' },
      },
    ];
    const out = convertToolsToResponses(tools);
    assert.ok(out);
    assert.equal(out!.length, 1);
    assert.equal(out![0].type, 'function');
    assert.equal(out![0].name, 'search');
    assert.equal(out![0].description, 'search the web');
    assert.deepEqual(out![0].parameters, { type: 'object' });
  });
});
