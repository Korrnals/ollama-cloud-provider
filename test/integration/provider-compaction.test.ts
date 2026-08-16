import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';

/**
 * v0.13.0 Slice 2 — provider compaction integration tests (spec:
 * docs/compaction-spec.md § Slice 2 tests).
 *
 * Pins the wiring contract of `maybeCompact` inside
 * `provideLanguageModelChatResponse`:
 *   - disabled → NO summarizer calls, messages unchanged (even over
 *     the fire threshold);
 *   - enabled + under threshold → passthrough, no summarizer call;
 *   - enabled + over threshold → messages REPLACED by the compacted
 *     list, summary-injected `role:'system'` message present, ONE 🧠
 *     annotation reported, and the ADR 0007 context filter applied
 *     to the COMPACTED list (proven via `safe`-level dedup of two
 *     identical recent user messages);
 *   - summarizer failure → warn + proceed with UNCOMPACTED messages,
 *     single attempt (no retry).
 *
 * Endpoint topology mirrors provider.test.ts: cloud connection pinned
 * to `preferredEndpoint: 'chat'` (`/chat/completions` SSE), so the
 * summarizer's native call is the ONLY traffic hitting `/api/chat` —
 * the fetch stub dispatches by URL. The huge-history tests exceed
 * 75% of gpt-oss:120b's 131072-token window with 10 large turns
 * (charsPerToken defaults to 4, no usage observed yet).
 */

const BASE_URL = 'https://ollama.com/v1';

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function configure(overrides: Record<string, unknown> = {}): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace({
    baseUrl: BASE_URL,
    allowedBaseUrls: [BASE_URL],
    requestTimeoutMs: 120000,
    maxRetries: 0,
    apiKey: '',
    connections: [
      { id: 'cloud', type: 'cloud', baseUrl: BASE_URL, preferredEndpoint: 'chat' },
    ],
    ...overrides,
  });
}

/**
 * Mock context WITH `globalStorageUri` (the compaction store root) —
 * mirrors provider.test.ts's makeMockContext plus the storage URI the
 * stub's createExtensionContext pattern fakes as a plain object.
 */
const storageDirs: string[] = [];
function makeCompactionContext(): { ctx: vscode.ExtensionContext } {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-provider-compaction-'),
  );
  storageDirs.push(storageDir);
  const ctx = {
    subscriptions: [],
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      },
      onDidChange: () => ({ dispose: () => undefined }),
    },
    extensionPath: '/test/extension-path',
    extensionUri: {
      toString: () => 'file:///test/extension-path',
      fsPath: '/test/extension-path',
    },
    globalStorageUri: {
      toString: () => `file://${storageDir}`,
      fsPath: storageDir,
    },
  } as unknown as vscode.ExtensionContext;
  return { ctx };
}

function chatInfoFor(apiModel: string): vscode.LanguageModelChatInformation {
  return {
    id: `ollama-cloud/${apiModel}`,
    name: apiModel,
    family: 'test',
    version: 'test',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    capabilities: { imageInput: false, toolCalling: true },
  } as unknown as vscode.LanguageModelChatInformation;
}

function userMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart(text)],
    name: undefined,
  };
}

function assistantMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [new vscode.LanguageModelTextPart(text)],
    name: undefined,
  };
}

function makeProgress(): vscode.Progress<vscode.LanguageModelResponsePart> & {
  parts: vscode.LanguageModelResponsePart[];
} {
  const parts: vscode.LanguageModelResponsePart[] = [];
  return {
    parts,
    report: (part) => {
      parts.push(part);
    },
  };
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

let apiChatCalls: RecordedCall[] = [];
let chatCalls: RecordedCall[] = [];

/**
 * Installs a URL-dispatching fetch stub: `/api/chat` is the
 * summarizer's non-streaming native call (checkpoint JSON or a 500),
 * everything else is the `/chat/completions` SSE stream.
 */
function installFetch(summarizer: 'ok' | 'fail' = 'ok'): void {
  apiChatCalls = [];
  chatCalls = [];
  global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const urlStr = String(url);
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (urlStr.includes('/api/chat')) {
      apiChatCalls.push({ url: urlStr, body: parsed });
      if (summarizer === 'fail') {
        return new Response('upstream overloaded', { status: 500 });
      }
      return new Response(
        JSON.stringify({ message: { content: 'CHECKPOINT SUMMARY' } }),
        { status: 200 },
      );
    }
    chatCalls.push({ url: urlStr, body: parsed });
    return new Response(
      streamFromChunks([
        encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n'),
        encode('data: [DONE]\n'),
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
}

const PAD = 42_000;

/**
 * 10 large turns ≈ 420k rendered chars ≈ 105k estimated tokens — over
 * the 75% fire threshold of gpt-oss:120b's 131072-token window. Turns
 * 9 and 10 carry IDENTICAL user content so the `safe` filter's dedup
 * is observable on the COMPACTED list (both live in the recency zone).
 */
function bigHistory(): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [];
  for (let i = 1; i <= 8; i++) {
    msgs.push(userMsg(`turn${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  const dup = 'dupmarker ' + 'x'.repeat(PAD);
  msgs.push(userMsg(dup));
  msgs.push(assistantMsg('ok'));
  msgs.push(userMsg(dup));
  msgs.push(assistantMsg('ok'));
  return msgs;
}

async function runProvider(
  messages: vscode.LanguageModelChatRequestMessage[],
  options: Record<string, unknown> = {},
): Promise<{
  progress: ReturnType<typeof makeProgress>;
}> {
  const { ctx } = makeCompactionContext();
  const provider = new OllamaCloudChatProvider(ctx);
  const progress = makeProgress();
  const token = new vscode.CancellationTokenSource().token;
  await provider.provideLanguageModelChatResponse(
    chatInfoFor('gpt-oss:120b'),
    messages,
    {
      modelOptions: {},
      justification: 'test',
      ...options,
    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
    progress,
    token,
  );
  return { progress };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('provider compaction wiring (v0.13.0 slice 2)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    configure();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disabled → NO summarizer calls even over the threshold; messages unchanged', async () => {
    installFetch('ok');
    // compaction.enabled not set → default false.
    const { progress } = await runProvider(bigHistory());

    assert.equal(apiChatCalls.length, 0, 'no /api/chat summarizer call');
    assert.equal(chatCalls.length, 1, 'chat endpoint called once');
    const chatBody = JSON.stringify(chatCalls[0]!.body);
    assert.ok(chatBody.includes('turn01'), 'evicted-zone turn still present (uncompacted)');
    assert.ok(!chatBody.includes('[compacted-turns'), 'no summary message injected');
    assert.ok(
      !progress.parts.some((p) => p instanceof vscode.LanguageModelTextPart && p.value.includes('🧠')),
      'no compaction annotation reported',
    );
  });

  it('enabled + under threshold → passthrough, no summarizer call', async () => {
    installFetch('ok');
    configure({ 'compaction.enabled': true });
    const { progress } = await runProvider([userMsg('hi')]);

    assert.equal(apiChatCalls.length, 0, 'under 75% — summarizer not called');
    assert.equal(chatCalls.length, 1);
    assert.ok(JSON.stringify(chatCalls[0]!.body).includes('hi'));
    assert.ok(
      !progress.parts.some((p) => p instanceof vscode.LanguageModelTextPart && p.value.includes('🧠')),
      'no compaction annotation reported',
    );
  });

  it('enabled + over threshold → compacted messages, summary injected, ONE annotation, filter applied to the compacted list', async () => {
    installFetch('ok');
    configure({
      'compaction.enabled': true,
      'contextFilter.level': 'safe',
    });
    const input = bigHistory();
    const { progress } = await runProvider(input);

    // --- summarizer call: single, native, non-streaming, cheap model.
    assert.equal(apiChatCalls.length, 1, 'exactly one summarizer call');
    const summarizerBody = apiChatCalls[0]!.body as {
      model: string;
      stream: boolean;
      think: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(summarizerBody.model, 'gpt-oss:20b', 'default summarizer model');
    assert.equal(summarizerBody.stream, false, 'non-streaming');
    assert.equal(summarizerBody.think, false, 'thinking disabled');
    assert.equal(summarizerBody.messages[0]!.role, 'user');
    assert.ok(
      summarizerBody.messages[0]!.content.includes('EVICTED BLOCK'),
      'prompt carries the evicted block',
    );

    // --- dispatched chat payload is the COMPACTED list.
    assert.equal(chatCalls.length, 1);
    const chatBody = JSON.stringify(chatCalls[0]!.body);
    assert.ok(chatBody.includes('[compacted-turns'), 'summary message injected');
    assert.ok(chatBody.includes('CHECKPOINT SUMMARY'), 'checkpoint text present');
    assert.ok(chatBody.includes('ocp-compaction://'), 'evicted-block pointer embedded');
    assert.ok(!chatBody.includes('turn01'), 'evicted turn01 removed from payload');
    assert.ok(chatBody.includes('turn05'), 'recency-zone turn05 kept');
    const dispatchedMessages = (chatCalls[0]!.body as { messages: unknown[] }).messages;
    assert.ok(
      dispatchedMessages.length < input.length,
      'dispatched message count smaller than input',
    );

    // --- ADR 0007 filter ran on the COMPACTED list: the two identical
    // recency-zone user messages dedup to one occurrence.
    assert.equal(
      occurrences(chatBody, 'dupmarker'),
      1,
      'safe-level dedup applied to the compacted list',
    );

    // --- exactly ONE 🧠 annotation with the before→after stats shape.
    const annotations = progress.parts.filter(
      (p): p is vscode.LanguageModelTextPart =>
        p instanceof vscode.LanguageModelTextPart && p.value.includes('🧠'),
    );
    assert.equal(annotations.length, 1, 'exactly one compaction annotation');
    assert.match(
      annotations[0]!.value,
      /🧠 Context compacted \d+→\d+ tokens/,
      'annotation carries the before→after token stats',
    );
  });

  it('summarizer failure → warn + proceed with UNCOMPACTED messages, single attempt', async () => {
    installFetch('fail');
    configure({ 'compaction.enabled': true });
    const { progress } = await runProvider(bigHistory());

    assert.equal(apiChatCalls.length, 1, 'single attempt — never retried');
    assert.equal(chatCalls.length, 1, 'chat still proceeds');
    const chatBody = JSON.stringify(chatCalls[0]!.body);
    assert.ok(chatBody.includes('turn01'), 'uncompacted history dispatched');
    assert.ok(!chatBody.includes('[compacted-turns'), 'no summary message');
    assert.ok(
      !progress.parts.some((p) => p instanceof vscode.LanguageModelTextPart && p.value.includes('🧠')),
      'no compaction annotation on failure',
    );
  });
});
