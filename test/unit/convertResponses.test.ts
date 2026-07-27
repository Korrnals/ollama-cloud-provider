import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  convertToResponsesInput,
  convertToolsToResponses,
} from '../../src/convertResponses.js';

const { LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolResultPart } =
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

describe('convertResponses.convertToResponsesInput', () => {
  it('maps a simple user text message to input[] with input_text', () => {
    const result = convertToResponsesInput([
      userMsg(new LanguageModelTextPart('hello')),
    ]);
    assert.equal(result.instructions, undefined);
    assert.equal(result.input.length, 1);
    assert.equal(result.input[0].type, 'message');
    assert.equal(result.input[0].role, 'user');
    assert.deepEqual(result.input[0].content, [
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
    const content = result.input[0].content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'input_text');
    assert.equal(content[1].type, 'input_image');
    assert.match(
      (content[1] as { image_url: string }).image_url,
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
    assert.equal(result.input[0].role, 'user');
  });

  it('maps multiple messages to multiple input items in order', () => {
    const result = convertToResponsesInput([
      userMsg(new LanguageModelTextPart('question')),
      assistantMsg(new LanguageModelTextPart('answer')),
      userMsg(new LanguageModelTextPart('follow-up')),
    ]);
    assert.equal(result.input.length, 3);
    assert.equal(result.input[0].role, 'user');
    assert.equal(result.input[1].role, 'assistant');
    assert.equal(result.input[2].role, 'user');
    // Assistant messages use output_text, user messages use input_text.
    assert.equal(result.input[1].content[0].type, 'output_text');
    assert.equal(result.input[2].content[0].type, 'input_text');
  });

  it('emits a tool_call_output content part for a tool result', () => {
    const result = convertToResponsesInput([
      userMsg(
        new LanguageModelToolResultPart('call-1', [
          new LanguageModelTextPart('result text'),
        ]),
      ),
    ]);
    assert.equal(result.input.length, 1);
    assert.equal(result.input[0].role, 'user');
    assert.equal(result.input[0].content[0].type, 'tool_call_output');
    assert.equal(
      (result.input[0].content[0] as { call_id: string }).call_id,
      'call-1',
    );
    assert.equal(
      (result.input[0].content[0] as { output: string }).output,
      'result text',
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