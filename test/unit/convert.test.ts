import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  countOpenAIRequestChars,
  getMessageText,
} from '../../src/convert.js';
import type { OpenAICompatibleMessage } from '../../src/protocolTypes.js';

const { LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart } =
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

describe('convert.convertMessagesToOpenAI', () => {
  it('maps user role with text', () => {
    const result = convertMessagesToOpenAI([
      userMsg(new LanguageModelTextPart('hello')),
    ]);
    assert.deepEqual(result, [{ role: 'user', content: 'hello' }]);
  });

  it('maps assistant role with text and tool_calls', () => {
    const result = convertMessagesToOpenAI([
      assistantMsg(
        new LanguageModelTextPart('calling tool'),
        new LanguageModelToolCallPart('call-1', 'search', { q: 'x' }),
      ),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.equal(result[0].content, 'calling tool');
    assert.ok(result[0].tool_calls);
    assert.equal(result[0].tool_calls!.length, 1);
    assert.equal(result[0].tool_calls![0].id, 'call-1');
    assert.equal(result[0].tool_calls![0].function.name, 'search');
    assert.deepEqual(JSON.parse(result[0].tool_calls![0].function.arguments), { q: 'x' });
  });

  it('emits tool role for tool result parts', () => {
    const result = convertMessagesToOpenAI([
      userMsg(
        new LanguageModelToolResultPart('call-1', [
          new LanguageModelTextPart('result text'),
        ]),
      ),
    ]);
    assert.equal(result.length, 1);
    const tool = result[0] as OpenAICompatibleMessage;
    assert.equal(tool.role, 'tool');
    assert.equal(tool.content, 'result text');
    assert.equal(tool.tool_call_id, 'call-1');
  });

  it('skips empty assistant message with no tool calls', () => {
    const result = convertMessagesToOpenAI([assistantMsg()]);
    assert.equal(result.length, 0, 'empty assistant must be dropped');
  });

  it('keeps assistant message with tool calls but empty text', () => {
    const result = convertMessagesToOpenAI([
      assistantMsg(new LanguageModelToolCallPart('c1', 't', {})),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.equal(result[0].content, '');
    assert.ok(result[0].tool_calls);
  });
});

describe('convert.convertToolsToOpenAI', () => {
  it('returns undefined for empty tools', () => {
    assert.equal(convertToolsToOpenAI([]), undefined);
    assert.equal(convertToolsToOpenAI(undefined), undefined);
  });

  it('maps a tool to OpenAI function form', () => {
    const tools: vscode.LanguageModelChatTool[] = [
      {
        name: 'search',
        description: 'search the web',
        inputSchema: { type: 'object' },
      },
    ];
    const out = convertToolsToOpenAI(tools);
    assert.ok(out);
    assert.equal(out!.length, 1);
    assert.equal(out![0].type, 'function');
    assert.equal(out![0].function.name, 'search');
    assert.equal(out![0].function.description, 'search the web');
    assert.deepEqual(out![0].function.parameters, { type: 'object' });
  });
});

describe('convert.countOpenAIRequestChars', () => {
  it('sums content, tool_call_id, and tool_calls', () => {
    const messages: OpenAICompatibleMessage[] = [
      { role: 'user', content: 'abc' },
      {
        role: 'tool',
        content: 'def',
        tool_call_id: 'id1',
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' },
          },
        ],
      },
    ];
    const total = countOpenAIRequestChars(messages);
    // content: 'abc' (3) + content: 'def' (3) + tool_call_id: 'id1' (3)
    // + tool_call.id: 'call1' (5) + function.name: 'search' (6)
    // + function.arguments: '{"q":"x"}' (9) = 29
    assert.equal(total, 29);
  });

  it('handles null content', () => {
    const messages: OpenAICompatibleMessage[] = [
      { role: 'user', content: null },
    ];
    assert.equal(countOpenAIRequestChars(messages), 0);
  });
});

describe('convert.getMessageText', () => {
  it('returns string inputs as-is', () => {
    assert.equal(getMessageText('hello'), 'hello');
  });

  it('extracts text parts from a message', () => {
    const msg = userMsg(
      new LanguageModelTextPart('foo'),
      new LanguageModelTextPart('bar'),
    );
    assert.equal(getMessageText(msg), 'foobar');
  });
});