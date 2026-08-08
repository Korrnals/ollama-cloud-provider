// ADR 0007 — context filter unit tests.
//
// Covers all three levels (`off` / `safe` / `aggressive`), the
// binding tool-call-integrity rule, vision-content pass-through,
// purity (same input → same output, no input mutation), and the
// `ContextFilterReport` fields. The filter is a pure function with
// no network/I/O/`Date.now()`/`logger` calls — these tests assert
// the ADR 0007 semantics directly against `filterContext`.
import { strict as assert } from 'node:assert';
import { filterContext } from '../../src/contextFilter.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
} from '../../src/protocolTypes.js';

// ---------------------------------------------------------------------------
// Builders — keep test cases terse and the message shape explicit.
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
    function: { name, description: `tool ${name}`, parameters: { type: 'object' } },
  };
}

function run(
  messages: OpenAICompatibleMessage[],
  level: 'off' | 'safe' | 'aggressive',
  maxInputTokens = 8192,
  tools?: OpenAICompatibleTool[],
) {
  return filterContext({
    messages,
    tools,
    level,
    maxInputTokens,
  });
}

// ---------------------------------------------------------------------------
// `off` level — fast path, no filtering, empty report.
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — off', () => {
  it('returns input unchanged at off', () => {
    const messages = [system('sys'), user('hi'), assistant('hello')];
    const result = run(messages, 'off');
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].content, 'sys');
    assert.equal(result.messages[1].content, 'hi');
    assert.equal(result.messages[2].content, 'hello');
  });

  it('emits an empty report at off', () => {
    const result = run([user('hi')], 'off');
    assert.equal(result.report.level, 'off');
    assert.equal(result.report.droppedMessages, 0);
    assert.equal(result.report.droppedTools, 0);
    assert.equal(result.report.mergedMessages, 0);
    assert.equal(result.report.truncatedMessages, 0);
    assert.equal(result.report.compactedSystemPrompt, false);
    assert.equal(result.report.strippedMetadataFields, 0);
    assert.equal(result.report.beforeChars, result.report.afterChars);
  });

  it('does not mutate the input array at off', () => {
    const messages = [user('hi')];
    const snapshot = messages.slice();
    run(messages, 'off');
    assert.deepEqual(messages, snapshot);
  });

  it('returns tools unchanged at off', () => {
    const tools = [tool('a'), tool('b')];
    const result = run([user('hi')], 'off', 8192, tools);
    assert.equal(result.tools!.length, 2);
    assert.equal(result.tools![0].function.name, 'a');
  });

  it('returns undefined tools when input tools are undefined at off', () => {
    const result = run([user('hi')], 'off');
    assert.equal(result.tools, undefined);
  });
});

// ---------------------------------------------------------------------------
// `safe` level — structural cleanup, no message removal (except empties).
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — safe: duplicate messages', () => {
  it('drops byte-for-byte duplicate user messages (string content)', () => {
    const messages = [user('hi'), user('hi'), user('bye')];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].content, 'hi');
    assert.equal(result.messages[1].content, 'bye');
    assert.equal(result.report.droppedMessages, 1);
  });

  it('keeps messages with same content but different role', () => {
    const messages = [user('hi'), assistant('hi')];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 2);
  });

  it('keeps the first occurrence and preserves order', () => {
    const messages = [user('first'), user('dup'), user('dup'), user('last')];
    const result = run(messages, 'safe');
    assert.deepEqual(
      result.messages.map((m) => m.content),
      ['first', 'dup', 'last'],
    );
  });

  it('compares image parts by reference identity, not bytes', () => {
    const imgA = {
      type: 'image_url' as const,
      image_url: { url: 'data:image/png;base64,AAAA' },
    };
    const imgB = {
      type: 'image_url' as const,
      image_url: { url: 'data:image/png;base64,AAAA' },
    };
    const messages = [
      { role: 'user' as const, content: [imgA] },
      { role: 'user' as const, content: [imgB] },
    ];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 2);
  });

  it('drops duplicate part-array messages when same reference', () => {
    const img = {
      type: 'image_url' as const,
      image_url: { url: 'data:image/png;base64,AAAA' },
    };
    const messages = [
      { role: 'user' as const, content: [img] },
      { role: 'user' as const, content: [img] },
    ];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 1);
  });
});

describe('contextFilter.filterContext — safe: empty content parts', () => {
  it('removes zero-length text parts', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '' },
          { type: 'text' as const, text: 'keep' },
        ],
      },
    ];
    const result = run(messages, 'safe');
    const content = result.messages[0].content as unknown as Array<{
      type: string;
      text: string;
    }>;
    assert.equal(content.length, 1);
    assert.equal(content[0].text, 'keep');
  });

  it('removes whitespace-only text parts', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '   ' },
          { type: 'text' as const, text: 'keep' },
        ],
      },
    ];
    const result = run(messages, 'safe');
    const content = result.messages[0].content as unknown as Array<{
      type: string;
      text: string;
    }>;
    assert.equal(content.length, 1);
    assert.equal(content[0].text, 'keep');
  });

  it('drops a message when all parts are empty and no tool_calls', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '' },
          { type: 'text' as const, text: '  ' },
        ],
      },
      user('keep'),
    ];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'keep');
  });

  it('keeps empty assistant message when it has tool_calls', () => {
    const messages = [
      assistantWithCall('call_1', 'ls', '{}', null),
      toolResult('call_1', 'a\nb'),
    ];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 2);
  });
});

describe('contextFilter.filterContext — safe: whitespace trim', () => {
  it('trims leading/trailing whitespace on text parts', () => {
    const messages = [user('  hello  ')];
    const result = run(messages, 'safe');
    assert.equal(result.messages[0].content, 'hello');
  });

  it('does NOT collapse internal whitespace at safe for non-system messages', () => {
    const messages = [user('hello     world')];
    const result = run(messages, 'safe');
    assert.equal(result.messages[0].content, 'hello     world');
  });
});

describe('contextFilter.filterContext — safe: dedup tools', () => {
  it('drops duplicate tools by function.name (first wins)', () => {
    const tools = [tool('search'), tool('search'), tool('calc')];
    const result = run([user('hi')], 'safe', 8192, tools);
    assert.equal(result.tools!.length, 2);
    assert.equal(result.tools![0].function.name, 'search');
    assert.equal(result.tools![1].function.name, 'calc');
    assert.equal(result.report.droppedTools, 1);
  });

  it('keeps all tools with distinct names', () => {
    const tools = [tool('a'), tool('b')];
    const result = run([user('hi')], 'safe', 8192, tools);
    assert.equal(result.tools!.length, 2);
  });

  it('returns undefined tools when input tools undefined', () => {
    const result = run([user('hi')], 'safe');
    assert.equal(result.tools, undefined);
  });
});

describe('contextFilter.filterContext — safe: system prompt compaction', () => {
  it('collapses whitespace runs in system string content', () => {
    const messages = [system('  hello   world  \n\n  next  ')];
    const result = run(messages, 'safe');
    assert.equal(result.messages[0].content, 'hello world next');
    assert.equal(result.report.compactedSystemPrompt, true);
  });

  it('does NOT compact non-system message whitespace', () => {
    const messages = [user('  hello   world  ')];
    const result = run(messages, 'safe');
    assert.equal(result.messages[0].content, 'hello   world');
    assert.equal(result.report.compactedSystemPrompt, false);
  });

  it('compacts text parts of system part-array content', () => {
    const messages = [
      {
        role: 'system' as const,
        content: [
          { type: 'text' as const, text: '  hello   world  ' },
          { type: 'text' as const, text: 'keep' },
        ],
      },
    ];
    const result = run(messages, 'safe');
    const content = result.messages[0].content as unknown as Array<{
      type: string;
      text: string;
    }>;
    assert.equal(content[0].text, 'hello world');
    assert.equal(content[1].text, 'keep');
    assert.equal(result.report.compactedSystemPrompt, true);
  });

  it('reports compactedSystemPrompt false when system prompt unchanged', () => {
    const messages = [system('already compact')];
    const result = run(messages, 'safe');
    assert.equal(result.report.compactedSystemPrompt, false);
  });
});

// ---------------------------------------------------------------------------
// `aggressive` level — safe + truncation + merging + metadata strip.
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — aggressive: truncation', () => {
  it('truncates oldest messages when over budget', () => {
    // ADR § aggressive: drop from the front until the estimate is
    // UNDER budget. `countOpenAIRequestChars` counts only content +
    // tool ids (no role overhead). 4 user messages of 4/4/4/5 chars =
    // 17 chars total. maxInputTokens=2 → budget = floor(2 * 0.9 * 4)
    // = 7 chars. The truncation loop drops front messages one at a
    // time, re-checking the budget after each drop:
    //   17 > 7 → drop 'aaaa' → 13 chars
    //   13 > 7 → drop 'bbbb' → 9 chars
    //    9 > 7 → drop 'cccc' → 5 chars
    //    5 ≤ 7 → stop
    // Only the last user message ('final', 5 chars) survives, and it
    // is preserved unconditionally. A looser budget (e.g. 14 chars at
    // maxInputTokens=4) stops after the first drop (13 ≤ 14) and
    // leaves 3 messages — that is also correct per the ADR, but this
    // test deliberately uses a tight budget so the truncation-depletes
    // path is exercised, not just the drop-one-and-stop path.
    const messages = [
      user('aaaa'), // index 0 — droppable
      user('bbbb'), // index 1 — droppable
      user('cccc'), // index 2 — droppable
      user('final'), // last user — preserved
    ];
    const result = run(messages, 'aggressive', 2);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'final');
    assert.ok(result.report.truncatedMessages >= 1);
  });

  it('preserves the system prompt unconditionally', () => {
    const messages = [
      system('sys prompt here'),
      user('aaaa'),
      user('bbbb'),
      user('final'),
    ];
    const result = run(messages, 'aggressive', 12);
    const roles = result.messages.map((m) => m.role);
    assert.ok(roles.includes('system'));
  });

  it('preserves the last user message unconditionally', () => {
    const messages = [user('aaaa'), user('bbbb'), user('final')];
    const result = run(messages, 'aggressive', 8);
    const contents = result.messages.map((m) => m.content);
    assert.ok(contents.includes('final'));
  });

  it('does not truncate when under budget', () => {
    const messages = [user('short'), user('also short')];
    const result = run(messages, 'aggressive', 8192);
    assert.equal(result.report.truncatedMessages, 0);
    assert.equal(result.messages.length, 2);
  });
});

describe('contextFilter.filterContext — aggressive: merging', () => {
  it('merges adjacent same-role messages with Jaccard >= 0.8', () => {
    const messages = [
      user('the quick brown fox'),
      user('the quick brown fox jumps'),
    ];
    const result = run(messages, 'aggressive', 8192);
    assert.equal(result.messages.length, 1);
    assert.equal(result.report.mergedMessages, 1);
    assert.equal(result.messages[0].content, 'the quick brown fox\nthe quick brown fox jumps');
  });

  it('does NOT merge adjacent messages with Jaccard < 0.8', () => {
    const messages = [
      user('alpha beta gamma'),
      user('delta epsilon zeta eta theta'),
    ];
    const result = run(messages, 'aggressive', 8192);
    assert.equal(result.messages.length, 2);
    assert.equal(result.report.mergedMessages, 0);
  });

  it('does NOT merge messages with different roles', () => {
    const messages = [
      user('the quick brown fox'),
      assistant('the quick brown fox'),
    ];
    const result = run(messages, 'aggressive', 8192);
    assert.equal(result.messages.length, 2);
  });

  it('does NOT merge non-adjacent similar messages (but dedup may act)', () => {
    // The two user messages are byte-identical — `safe` dedup drops
    // the second one (same role + identical content) BEFORE
    // `aggressive` merging runs. The result has 2 messages (user +
    // assistant), and `mergedMessages` is 0 (no adjacent merge). This
    // confirms non-adjacent messages are never merged — dedup handles
    // the identical pair, merging handles the similar-but-not-identical
    // adjacent pair.
    const messages = [
      user('the quick brown fox'),
      assistant('different'),
      user('the quick brown fox'),
    ];
    const result = run(messages, 'aggressive', 8192);
    assert.equal(result.messages.length, 2);
    assert.equal(result.report.mergedMessages, 0);
  });

  it('does NOT merge tool-call-bearing messages', () => {
    const messages = [
      assistantWithCall('call_1', 'ls', '{}', 'listing'),
      assistantWithCall('call_1', 'ls', '{}', 'listing'),
    ];
    const result = run(messages, 'aggressive', 8192);
    // Tool-call integrity: identical tool_calls — dedup at safe drops
    // the duplicate, but merging must never combine tool-bearing
    // messages. After dedup we expect 1, mergedMessages 0.
    assert.equal(result.messages.length, 1);
    assert.equal(result.report.mergedMessages, 0);
  });

  it('concatenates merged content with a single newline', () => {
    // ADR § aggressive merge: content concatenated with a SINGLE `\n`.
    // The two messages must be similar (Jaccard ≥ 0.8) but NOT
    // byte-identical — `safe` dedup (which runs before `aggressive`
    // merge) drops a byte-identical same-role pair, so an identical
    // pair never reaches the merge step. Use two strings that share
    // 4 of 5 words (Jaccard = 4/5 = 0.8 ≥ threshold) but differ in
    // the trailing word so dedup keeps both and merge concatenates
    // them with exactly one `\n` (not `\n\n`, not a space).
    const messages = [user('aaa bbb ccc ddd'), user('aaa bbb ccc ddd eee')];
    const result = run(messages, 'aggressive', 8192);
    assert.equal(result.messages.length, 1);
    assert.equal(result.report.mergedMessages, 1);
    assert.equal(result.messages[0].content, 'aaa bbb ccc ddd\naaa bbb ccc ddd eee');
  });
});

describe('contextFilter.filterContext — aggressive: metadata strip', () => {
  it('strips the name field', () => {
    const messages = [
      { role: 'user', content: 'hi', name: 'alice' },
    ] as OpenAICompatibleMessage[];
    const result = run(messages, 'aggressive');
    assert.equal((result.messages[0] as { name?: string }).name, undefined);
    assert.ok(result.report.strippedMetadataFields >= 1);
  });

  it('strips empty refusal but keeps non-empty refusal', () => {
    const messages = [
      { role: 'assistant', content: 'no', refusal: '' },
    ] as OpenAICompatibleMessage[];
    const result = run(messages, 'aggressive');
    assert.equal((result.messages[0] as { refusal?: string }).refusal, undefined);

    const messages2 = [
      { role: 'assistant', content: 'no', refusal: 'policy' },
    ] as OpenAICompatibleMessage[];
    const result2 = run(messages2, 'aggressive');
    assert.equal((result2.messages[0] as { refusal?: string }).refusal, 'policy');
  });

  it('strips unknown top-level keys', () => {
    const messages = [
      {
        role: 'user',
        content: 'hi',
        custom_field: 'x',
      } as unknown as OpenAICompatibleMessage,
    ];
    const result = run(messages, 'aggressive');
    assert.equal(
      (result.messages[0] as { custom_field?: string }).custom_field,
      undefined,
    );
  });

  it('never strips role, content, tool_calls, tool_call_id', () => {
    const messages = [
      assistantWithCall('call_1', 'ls', '{}', 'text'),
      toolResult('call_1', 'a'),
    ];
    const result = run(messages, 'aggressive');
    assert.equal(result.messages.length, 2);
    const asst = result.messages[0];
    assert.equal(asst.role, 'assistant');
    assert.equal(asst.content, 'text');
    assert.ok(asst.tool_calls && asst.tool_calls.length === 1);
    const toolMsg = result.messages[1];
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
  });
});

// ---------------------------------------------------------------------------
// Tool-call integrity — binding rule (4 scenarios).
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — tool-call integrity', () => {
  it('scenario 1: dropping the assistant call also drops its tool output', () => {
    // Duplicate the assistant+tool pair so safe dedup drops one
    // assistant call; integrity must also drop its matching tool output.
    const messages = [
      user('list files'),
      assistantWithCall('call_1', 'ls', '{}'),
      toolResult('call_1', 'a\nb'),
      assistantWithCall('call_1', 'ls', '{}'), // duplicate call
      toolResult('call_1', 'a\nb'), // duplicate output
      assistant('The files are: a, b'),
    ];
    const result = run(messages, 'aggressive');
    // After dedup + integrity: user, call, tool, final assistant.
    const callIds = result.messages
      .filter((m) => m.tool_calls)
      .flatMap((m) => m.tool_calls!.map((c) => c.id));
    const toolIds = result.messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.tool_call_id);
    assert.deepEqual(callIds.sort(), toolIds.sort());
    // No orphan: every tool_call_id has a tool message and vice versa.
    assert.equal(callIds.length, toolIds.length);
  });

  it('scenario 2: dropping a tool output removes the matching tool_call', () => {
    // Duplicate tool result → dedup drops one tool message; integrity
    // must keep the call paired (one call, one output remains).
    const messages = [
      assistantWithCall('call_1', 'ls', '{}'),
      toolResult('call_1', 'a'),
      toolResult('call_1', 'a'), // duplicate
    ];
    const result = run(messages, 'aggressive');
    const toolCount = result.messages.filter((m) => m.role === 'tool').length;
    const callCount = result.messages
      .filter((m) => m.tool_calls)
      .reduce((acc, m) => acc + m.tool_calls!.length, 0);
    assert.equal(toolCount, 1);
    assert.equal(callCount, 1);
  });

  it('scenario 3: orphaned tool_call_output (no issuing call) is dropped', () => {
    const messages = [
      user('hi'),
      toolResult('orphan_call', 'result'), // no assistant issued this
      assistant('done'),
    ];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[1].role, 'assistant');
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 0);
  });

  it('scenario 4: orphaned tool_call (no output) is removed from assistant', () => {
    const messages = [
      assistantWithCall('call_no_output', 'ls', '{}', null),
      user('next'),
    ];
    const result = run(messages, 'safe');
    // The assistant had only the tool_call (no content, no matching
    // tool output) — integrity drops it entirely.
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
  });
});

// ---------------------------------------------------------------------------
// Vision content — never filtered at any level.
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — vision never filtered', () => {
  const img = {
    type: 'image_url' as const,
    image_url: { url: 'data:image/png;base64,AAAA' },
  };

  it('keeps image parts at safe', () => {
    const messages = [
      { role: 'user' as const, content: [img, { type: 'text' as const, text: 'see this' }] },
    ];
    const result = run(messages, 'safe');
    const content = result.messages[0].content as unknown as Array<{ type: string }>;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'image_url');
  });

  it('keeps image parts at aggressive', () => {
    const messages = [
      { role: 'user' as const, content: [img, { type: 'text' as const, text: 'see this' }] },
    ];
    const result = run(messages, 'aggressive');
    const content = result.messages[0].content as unknown as Array<{ type: string }>;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'image_url');
  });

  it('does not drop a message whose only content is an image', () => {
    const messages = [{ role: 'user' as const, content: [img] }];
    const result = run(messages, 'safe');
    assert.equal(result.messages.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Purity — same input always yields same output; input not mutated.
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — purity', () => {
  it('does not mutate the input messages array', () => {
    const messages = [user('hi'), user('hi'), user('bye')];
    const snapshot = messages.map((m) => ({ ...m }));
    run(messages, 'safe');
    assert.deepEqual(messages, snapshot);
  });

  it('does not mutate the input tools array', () => {
    const tools = [tool('a'), tool('a')];
    const snapshot = tools.map((t) => ({ ...t, function: { ...t.function } }));
    run([user('hi')], 'safe', 8192, tools);
    assert.deepEqual(tools, snapshot);
  });

  it('returns identical output for identical input (safe)', () => {
    const messages = [user('hi'), user('hi')];
    const a = run(messages, 'safe');
    const b = run(messages, 'safe');
    assert.deepEqual(a, b);
  });

  it('returns identical output for identical input (aggressive)', () => {
    const messages = [user('the quick brown fox'), user('the quick brown fox')];
    const a = run(messages, 'aggressive');
    const b = run(messages, 'aggressive');
    assert.deepEqual(a, b);
  });

  it('output messages are not the same object references as input', () => {
    const m = user('hi');
    const result = run([m], 'aggressive');
    assert.notStrictEqual(result.messages[0], m);
  });
});

// ---------------------------------------------------------------------------
// Report fields — populated correctly for each level.
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — report fields', () => {
  it('report.level matches the input level', () => {
    assert.equal(run([user('hi')], 'off').report.level, 'off');
    assert.equal(run([user('hi')], 'safe').report.level, 'safe');
    assert.equal(run([user('hi')], 'aggressive').report.level, 'aggressive');
  });

  it('beforeChars and afterChars are populated', () => {
    const result = run([user('hi'), user('hi')], 'safe');
    assert.ok(result.report.beforeChars > 0);
    assert.ok(result.report.afterChars < result.report.beforeChars);
  });

  it('aggressive report sums droppedMessages from safe + integrity', () => {
    const messages = [
      user('hi'),
      user('hi'), // duplicate → safe drop
      toolResult('orphan', 'x'), // orphan → integrity drop
    ];
    const result = run(messages, 'aggressive');
    assert.ok(result.report.droppedMessages >= 2);
  });

  it('safe report has zero merged/truncated/stripped counts', () => {
    const result = run([user('hi')], 'safe');
    assert.equal(result.report.mergedMessages, 0);
    assert.equal(result.report.truncatedMessages, 0);
    assert.equal(result.report.strippedMetadataFields, 0);
  });
});

// ---------------------------------------------------------------------------
// Empty input edge cases.
// ---------------------------------------------------------------------------

describe('contextFilter.filterContext — edge cases', () => {
  it('handles empty messages array at off', () => {
    const result = run([], 'off');
    assert.equal(result.messages.length, 0);
    assert.equal(result.report.beforeChars, 0);
  });

  it('handles empty messages array at safe', () => {
    const result = run([], 'safe');
    assert.equal(result.messages.length, 0);
  });

  it('handles empty tools array (returns undefined)', () => {
    const result = run([user('hi')], 'safe', 8192, []);
    assert.equal(result.tools, undefined);
  });

  it('handles a single message at aggressive with no truncation', () => {
    const result = run([user('hi')], 'aggressive');
    assert.equal(result.messages.length, 1);
    assert.equal(result.report.truncatedMessages, 0);
  });
});
