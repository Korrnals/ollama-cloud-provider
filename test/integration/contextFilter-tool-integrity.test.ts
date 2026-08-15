// Integration tests — context filter tool-call integrity (ADR 0007).
//
// These are integration-level scenarios verifying that the filter
// preserves tool-call chains across realistic multi-turn workflows.
// They complement `test/unit/contextFilter.test.ts` (which covers the
// mechanics in isolation) by exercising the full `filterContext` entry
// point on conversation shapes that mirror real subagent / agent loops.
//
// The filter is a pure function (no network, no I/O) — these tests
// assert the ADR 0007 tool-call-integrity contract end-to-end:
//   - safe level never drops a tool_call_output whose call survives
//   - safe distinguishes results by tool_call_id (not just content)
//   - aggressive truncation leaves no orphaned tool_call_output
//   - aggressive merging skips tool-bearing messages
//   - realistic subagent workflows survive safe filtering intact
import { strict as assert } from 'node:assert';
import { filterContext } from '../../src/contextFilter.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
} from '../../src/protocolTypes.js';

// ---------------------------------------------------------------------------
// Builders — mirror the unit-test helpers so cases stay terse.
// ---------------------------------------------------------------------------

function user(content: string): OpenAICompatibleMessage {
  return { role: 'user', content };
}

function assistant(content: string): OpenAICompatibleMessage {
  return { role: 'assistant', content };
}

function system(content: string): OpenAICompatibleMessage {
  return { role: 'system', content };
}

function assistantWithCall(
  callId: string,
  name: string,
  args: string,
  content: string | null = null,
): OpenAICompatibleMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: [
      { id: callId, type: 'function', function: { name, arguments: args } },
    ],
  };
}

function toolResult(callId: string, content: string): OpenAICompatibleMessage {
  return { role: 'tool', tool_call_id: callId, content };
}

function tool(name: string): OpenAICompatibleTool {
  return {
    type: 'function',
    function: {
      name,
      description: `tool ${name}`,
      parameters: { type: 'object' },
    },
  };
}

function run(
  messages: OpenAICompatibleMessage[],
  level: 'off' | 'safe' | 'aggressive',
  maxInputTokens = 8192,
  tools?: OpenAICompatibleTool[],
) {
  return filterContext({ messages, tools, level, maxInputTokens });
}

/**
 * Collects every tool_call id present on assistant messages.
 */
function assistantCallIds(messages: OpenAICompatibleMessage[]): string[] {
  return messages
    .filter((m) => m.tool_calls !== undefined && m.tool_calls.length > 0)
    .flatMap((m) => m.tool_calls!.map((c) => c.id));
}

/**
 * Collects every tool_call_id present on tool-role messages.
 */
function toolResultIds(messages: OpenAICompatibleMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'tool' && m.tool_call_id !== undefined)
    .map((m) => m.tool_call_id!);
}

/**
 * Integrity invariant: every tool_call has a matching tool_call_output
 * and vice versa. No orphans in either direction.
 */
function assertNoOrphans(messages: OpenAICompatibleMessage[]): void {
  const callIds = new Set(assistantCallIds(messages));
  const resultIds = new Set(toolResultIds(messages));
  for (const id of callIds) {
    assert.ok(
      resultIds.has(id),
      `orphaned tool_call "${id}" has no matching tool_call_output`,
    );
  }
  for (const id of resultIds) {
    assert.ok(
      callIds.has(id),
      `orphaned tool_call_output "${id}" has no issuing tool_call`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — safe level preserves a tool_call_output whose call survives.
// ---------------------------------------------------------------------------

describe('contextFilter tool-integrity (integration) — safe preserves tool_call_output', () => {
  it('keeps an assistant tool_call + its tool result unchanged at safe', () => {
    const messages = [
      user('list files'),
      assistantWithCall('call_1', 'ls', '{"path":"/tmp"}'),
      toolResult('call_1', 'a\nb\nc'),
      assistant('found 3 files'),
    ];
    const result = run(messages, 'safe');

    // The tool result must survive — its content is intact.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].tool_call_id, 'call_1');
    assert.equal(toolMsgs[0].content, 'a\nb\nc');

    // The issuing assistant call also survives.
    const callMsgs = result.messages.filter(
      (m) => m.tool_calls !== undefined && m.tool_calls.length > 0,
    );
    assert.equal(callMsgs.length, 1);
    assert.equal(callMsgs[0].tool_calls![0].id, 'call_1');
    assert.equal(callMsgs[0].tool_calls![0].function.name, 'ls');

    // No drops at safe (no duplicates, no empties).
    assert.equal(result.report.droppedMessages, 0);
    assert.equal(result.report.truncatedMessages, 0);

    assertNoOrphans(result.messages);
  });

  it('keeps the tool result when tools are also passed', () => {
    const messages = [
      user('run search'),
      assistantWithCall('call_1', 'search', '{"q":"x"}'),
      toolResult('call_1', 'hit1\nhit2'),
      assistant('two hits'),
    ];
    const result = run(messages, 'safe', 8192, [
      tool('search'),
      tool('ls'),
    ]);

    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].content, 'hit1\nhit2');
    assertNoOrphans(result.messages);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — safe does NOT dedup tool results that share content but
// differ in tool_call_id. Distinct calls produce distinct outputs even
// when the bytes match.
// ---------------------------------------------------------------------------

describe('contextFilter tool-integrity (integration) — safe distinguishes results by tool_call_id', () => {
  it('keeps both tool results when content is identical but IDs differ', () => {
    // Two independent assistant calls, each producing the same result
    // text. These are NOT duplicates — different tool_call_id.
    const messages = [
      assistantWithCall('call_A', 'ls', '{}'),
      toolResult('call_A', 'same output'),
      assistantWithCall('call_B', 'ls', '{}'),
      toolResult('call_B', 'same output'),
      assistant('done'),
    ];
    const result = run(messages, 'safe');

    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2, 'both tool results survive');
    const ids = toolMsgs.map((m) => m.tool_call_id).sort();
    assert.deepEqual(ids, ['call_A', 'call_B']);

    // Nothing dropped — they are not duplicates by the structural rule.
    assert.equal(result.report.droppedMessages, 0);
    assertNoOrphans(result.messages);
  });

  it('keeps three tool results with identical content and three distinct IDs', () => {
    const messages = [
      assistantWithCall('c1', 'ping', '{}'),
      toolResult('c1', 'pong'),
      assistantWithCall('c2', 'ping', '{}'),
      toolResult('c2', 'pong'),
      assistantWithCall('c3', 'ping', '{}'),
      toolResult('c3', 'pong'),
      assistant('all pong'),
    ];
    const result = run(messages, 'safe');

    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 3);
    assert.equal(result.report.droppedMessages, 0);
    assertNoOrphans(result.messages);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — safe DOES dedup true duplicates: same tool_call_id AND
// same content. A repeated tool result is collapsed to one.
// ---------------------------------------------------------------------------

describe('contextFilter tool-integrity (integration) — safe dedups true duplicate results', () => {
  it('drops a tool result that is byte-identical to a prior one with the same id', () => {
    const messages = [
      assistantWithCall('call_1', 'ls', '{}'),
      toolResult('call_1', 'a\nb'),
      toolResult('call_1', 'a\nb'), // true duplicate
      assistant('done'),
    ];
    const result = run(messages, 'safe');

    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1, 'duplicate tool result dropped');
    assert.equal(toolMsgs[0].tool_call_id, 'call_1');

    // One message was dropped (the duplicate), plus the orphaned
    // duplicate assistant call (there was only one assistant call, so
    // no assistant orphan). droppedMessages reflects the dedup.
    assert.ok(
      result.report.droppedMessages >= 1,
      'at least the duplicate was dropped',
    );
    assertNoOrphans(result.messages);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — aggressive truncation preserves tool integrity. When the
// truncation step drops an assistant tool_call, the matching tool result
// becomes orphaned; enforceToolCallIntegrity (called after truncation)
// must remove it. The output never contains an orphaned tool_call_output.
// ---------------------------------------------------------------------------

describe('contextFilter tool-integrity (integration) — aggressive truncation leaves no orphans', () => {
  it('removes orphaned tool_call_output after truncation drops the assistant call', () => {
    // A large system prompt + a droppable assistant tool_call + its
    // tool result + a preserved last user message. With a tiny token
    // budget, truncation drops the assistant call (it is the first
    // droppable message after the system prompt), orphaning the tool
    // result. integrity then removes the orphaned result.
    const bigSystem = 'S '.repeat(400); // ~800 chars, eats the budget
    const messages = [
      system(bigSystem),
      assistantWithCall('call_1', 'ls', '{}'),
      toolResult('call_1', 'result payload'),
      user('final question'),
    ];
    const result = run(messages, 'aggressive', 1);

    // Truncation must have happened.
    assert.ok(
      result.report.truncatedMessages > 0,
      'truncation dropped at least one message',
    );

    // The binding invariant: no orphan in either direction.
    assertNoOrphans(result.messages);

    // Specifically: if the tool result for call_1 survived, then the
    // assistant call for call_1 must also survive. If the call was
    // truncated, the result must be gone too.
    const resultIds = new Set(toolResultIds(result.messages));
    const callIds = new Set(assistantCallIds(result.messages));
    if (resultIds.has('call_1')) {
      assert.ok(
        callIds.has('call_1'),
        'tool result survived but its issuing call did not — orphan',
      );
    }
  });

  it('preserves a complete call/result pair when the budget is generous', () => {
    const messages = [
      system('sys'),
      user('list'),
      assistantWithCall('call_1', 'ls', '{}'),
      toolResult('call_1', 'a\nb'),
      assistant('found a, b'),
      user('thanks'),
    ];
    const result = run(messages, 'aggressive', 8192);

    // Generous budget → nothing truncated, pair survives intact.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].content, 'a\nb');
    assertNoOrphans(result.messages);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — aggressive does NOT merge tool-bearing messages. Two
// adjacent assistant-with-tool_calls messages must survive as distinct,
// even if their content is identical (which would otherwise trigger
// the Jaccard merge).
// ---------------------------------------------------------------------------

describe('contextFilter tool-integrity (integration) — aggressive skips tool-bearing messages in merge', () => {
  it('does not merge two adjacent assistant messages that both carry tool_calls', () => {
    // Two assistant turns with identical content AND identical tool
    // call shape — but different call ids. At aggressive, applyMerge
    // must skip both (tool-bearing), leaving them as separate messages.
    const messages = [
      user('go'),
      assistantWithCall('call_A', 'ls', '{}'),
      toolResult('call_A', 'r1'),
      assistantWithCall('call_B', 'ls', '{}'),
      toolResult('call_B', 'r2'),
      user('done'),
    ];
    const result = run(messages, 'aggressive', 8192);

    const callMsgs = result.messages.filter(
      (m) => m.tool_calls !== undefined && m.tool_calls.length > 0,
    );
    assert.equal(callMsgs.length, 2, 'both tool-bearing assistants kept separate');
    assert.equal(result.report.mergedMessages, 0);
    assertNoOrphans(result.messages);
  });

  it('does not merge an assistant tool_call with an adjacent tool result', () => {
    // Adjacent assistant-with-call and tool-role message: even though
    // they are different roles (merge requires same role anyway), this
    // confirms tool-bearing messages never enter the merge path.
    const messages = [
      user('go'),
      assistantWithCall('call_1', 'ls', '{}'),
      toolResult('call_1', 'r'),
      assistant('done'),
    ];
    const result = run(messages, 'aggressive', 8192);

    assert.equal(result.report.mergedMessages, 0);
    // All four + the tool result survive.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assertNoOrphans(result.messages);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — subagent workflow simulation. A realistic multi-turn
// conversation mirroring an agent loop: system prompt → user asks →
// assistant calls a tool → tool returns a result → assistant uses the
// result → user follows up. Safe filtering must preserve the ENTIRE
// chain, especially the tool result the owner suspects may be dropped.
// ---------------------------------------------------------------------------

describe('contextFilter tool-integrity (integration) — subagent workflow survives safe', () => {
  it('preserves the full tool chain in a realistic agent loop', () => {
    const messages: OpenAICompatibleMessage[] = [
      system('You are a helpful coding agent. Use tools when needed.'),
      user('What files are in the project root?'),
      assistantWithCall(
        'call_ls',
        'list_files',
        '{"path":"."}',
      ),
      toolResult('call_ls', 'README.md\npackage.json\nsrc\ntest'),
      assistant('The project root contains README.md, package.json, a src directory, and a test directory.'),
      user('Now read the README.md file.'),
      assistantWithCall(
        'call_read',
        'read_file',
        '{"path":"README.md"}',
      ),
      toolResult('call_read', '# Ollama Cloud Provider\n\nA VS Code extension.'),
      assistant('The README describes the Ollama Cloud Provider VS Code extension.'),
      user('Great, summarize what this project does.'),
    ];

    const result = run(messages, 'safe', 8192, [
      tool('list_files'),
      tool('read_file'),
    ]);

    // The full chain survives — 10 messages in, 10 out (no duplicates).
    assert.equal(result.messages.length, messages.length);
    assert.equal(result.report.droppedMessages, 0);

    // Both tool results survive with their original content.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    const lsResult = toolMsgs.find((m) => m.tool_call_id === 'call_ls');
    const readResult = toolMsgs.find((m) => m.tool_call_id === 'call_read');
    assert.ok(lsResult, 'list_files result survived');
    assert.ok(readResult, 'read_file result survived');
    assert.equal(lsResult!.content, 'README.md\npackage.json\nsrc\ntest');
    assert.equal(readResult!.content, '# Ollama Cloud Provider\n\nA VS Code extension.');

    // Both assistant tool_calls survive.
    const callIds = assistantCallIds(result.messages).sort();
    assert.deepEqual(callIds, ['call_ls', 'call_read']);

    // Order preserved: system → user → call → result → assistant → ...
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[2].role, 'assistant');
    assert.ok(result.messages[2].tool_calls !== undefined);
    assert.equal(result.messages[3].role, 'tool');

    // Tools also survive (deduped by name, both distinct).
    assert.equal(result.tools!.length, 2);

    assertNoOrphans(result.messages);
  });

  it('preserves the tool chain at aggressive when the budget is generous', () => {
    const messages: OpenAICompatibleMessage[] = [
      system('agent'),
      user('check status'),
      assistantWithCall('call_1', 'check_status', '{}'),
      toolResult('call_1', 'OK'),
      assistant('status is OK'),
      user('proceed'),
    ];

    const result = run(messages, 'aggressive', 8192, [tool('check_status')]);

    // No truncation, no merge (tool-bearing skipped), pair intact.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].content, 'OK');
    assert.equal(result.report.truncatedMessages, 0);
    assert.equal(result.report.mergedMessages, 0);
    assertNoOrphans(result.messages);
  });
});
