import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  convertToResponsesInput,
  convertToolsToResponses,
} from '../../src/convertResponses.js';
import type { ResponsesInputItem } from '../../src/protocolTypes.js';

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