import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { clearCapabilityCache } from '../../src/capabilityCache.js';

/**
 * P1-1 (cascade review 2026-10-02) — composition regression pin (T-2).
 *
 * Defect: compaction injects the evicted-block checkpoint as a SECOND
 * `role:'system'` message after the real system prompt. The
 * `/v1/responses` converters hoisted only the FIRST system message to
 * top-level `instructions` and DISCARDED the rest — the checkpoint (and
 * with it the entire evicted conversation, since the d1 sticky
 * projection replaces the raw prefix EVERY turn) never reached the
 * model on `/v1/responses`.
 *
 * These tests drive the FULL provider dispatch with a fetch stub,
 * mirroring `compactionStickiness.test.ts` but pinning
 * `preferredEndpoint: 'responses'` (and `'native'` as the unchanged
 * control) with the context filter at `safe` — the configuration under
 * which the dispatch actually feeds the COMPACTED OpenAI message list
 * through `convertOpenAIMessagesToResponsesInput`
 * (`convertToResponsesInput` on the raw VS Code messages is the
 * filter-`off` branch, which never carries the checkpoint).
 *
 * Topology per fetch stub:
 *   - `/api/chat` + `stream:false` → the summarizer (JSON response);
 *   - `/v1/responses` → the responses dispatch (SSE event stream);
 *   - `/api/chat` + `stream:true` → the native dispatch (ndjson).
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

/** `event: <type>\ndata: <json>\n\n` — the /v1/responses SSE frame. */
function sseEvent(type: string, json: string): Uint8Array {
  return encode(`event: ${type}\ndata: ${json}\n\n`);
}

function configure(overrides: Record<string, unknown> = {}): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace({
    baseUrl: BASE_URL,
    allowedBaseUrls: [BASE_URL],
    requestTimeoutMs: 120000,
    maxRetries: 0,
    apiKey: '',
    connections: [
      {
        id: 'cloud',
        type: 'cloud',
        baseUrl: BASE_URL,
        preferredEndpoint: 'responses',
        contextFilter: 'safe',
      },
    ],
    ...overrides,
  });
}

const storageDirs: string[] = [];
function makeCompactionContext(): vscode.ExtensionContext {
  const secrets = new Map([['ollamaCloud.apiKey', 'sk-test-key']]);
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ocp-compaction-responses-test-'),
  );
  storageDirs.push(storageDir);
  return {
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

// The stub defines a `System` member (value 1) that the official
// `@types/vscode` enum does not declare — same cast trick as
// `convertResponses.test.ts`. A leading system message is REQUIRED
// here: it makes the injected checkpoint the SECOND system message,
// which is the exact shape the hoist used to drop.
function systemMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: 1 as unknown as vscode.LanguageModelChatMessageRole,
    content: [new vscode.LanguageModelTextPart(text)] as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

function makeProgress(): vscode.Progress<vscode.LanguageModelResponsePart> {
  return { report: () => undefined };
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

let apiChatCalls: RecordedCall[] = [];
let nativeCalls: RecordedCall[] = [];
let responsesCalls: RecordedCall[] = [];

function installFetch(): void {
  apiChatCalls = [];
  nativeCalls = [];
  responsesCalls = [];
  global.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const urlStr = String(url);
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (urlStr.includes('/v1/responses')) {
      responsesCalls.push({ url: urlStr, body: parsed });
      return new Response(
        streamFromChunks([
          sseEvent('response.output_text.delta', '{"delta":"ok","item_id":"m1"}'),
          sseEvent(
            'response.completed',
            '{"response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
          ),
        ]),
        { status: 200 },
      );
    }
    if (urlStr.includes('/api/chat') && parsed.stream === true) {
      // Native /api/chat dispatch streams ndjson.
      nativeCalls.push({ url: urlStr, body: parsed });
      return new Response(
        streamFromChunks([
          encode('{"message":{"content":"ok"}}\n'),
          encode('{"done":true}\n'),
        ]),
        { status: 200 },
      );
    }
    if (urlStr.includes('/api/chat')) {
      // Summarizer (`nativeChatOnce`, `stream:false`).
      apiChatCalls.push({ url: urlStr, body: parsed });
      return new Response(
        JSON.stringify({ message: { content: 'CHECKPOINT SUMMARY' } }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const PAD = 36_000;

/**
 * Same growth shape as `compactionStickiness.test.ts`, plus a LEADING
 * system message so the injected checkpoint lands as the SECOND system
 * message (the drop shape P1-1 fixed).
 */
function bigHistory(extraTurns = 0, tag = 'turn'): vscode.LanguageModelChatRequestMessage[] {
  const msgs: vscode.LanguageModelChatRequestMessage[] = [systemMsg('You are a coding assistant.')];
  for (let i = 1; i <= 12 + extraTurns; i++) {
    msgs.push(userMsg(`${tag}${String(i).padStart(2, '0')} ` + 'x'.repeat(PAD)));
    msgs.push(assistantMsg('ok'));
  }
  return msgs;
}

async function runTurn(
  provider: OllamaCloudChatProvider,
  messages: vscode.LanguageModelChatRequestMessage[],
): Promise<void> {
  await provider.provideLanguageModelChatResponse(
    chatInfoFor('gpt-oss:120b'),
    messages,
    { modelOptions: {}, justification: 'test' } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
    makeProgress(),
    new vscode.CancellationTokenSource().token,
  );
}

describe('compaction checkpoint on /v1/responses — P1-1 composition pin (T-2)', function () {
  // Provider-level composition tests: each turn runs the full
  // vision-gate → compaction → filter → convert → SSE pipeline
  // (~10ms per turn in isolation, measured). The default 5s budget
  // flakes when the SSRF guard's DNS lookup stalls under full-suite
  // load on a busy host — same pattern (and remedy) as
  // `budgetAndNotice.test.ts` / `commitWindow.test.ts`.
  this.timeout(20000);

  let originalFetch: typeof fetch;

  beforeEach(() => {
    clearCapabilityCache();
    configure();
    originalFetch = global.fetch;
    installFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves the checkpoint in instructions on the fire turn AND the sticky re-apply turn (responses + safe filter)', async () => {
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    // --- Call 1: compaction fires; the /v1/responses dispatch must
    //     carry the checkpoint in top-level `instructions`.
    await runTurn(provider, bigHistory());
    assert.equal(apiChatCalls.length, 1, 'call 1: exactly one summarizer call');
    assert.equal(responsesCalls.length, 1, 'call 1: /v1/responses dispatched');

    const body1 = responsesCalls[0]!.body as { instructions?: string; input: unknown[] };
    assert.ok(body1.instructions !== undefined, 'call 1: instructions present');
    // The real system prompt still LEADS the instructions (first-hoist
    // unchanged for the ordinary system message)...
    assert.ok(
      body1.instructions!.startsWith('You are a coding assistant.'),
      'call 1: real system prompt still leads instructions',
    );
    // ...and the checkpoint (marker + summary body) is folded in behind it.
    assert.ok(
      body1.instructions!.includes('[compacted-turns'),
      'call 1: checkpoint marker folded into instructions',
    );
    assert.ok(
      body1.instructions!.includes('CHECKPOINT SUMMARY'),
      'call 1: checkpoint summary body folded into instructions',
    );
    // The evicted prefix is gone from the wire; the recency tail stays.
    const input1 = JSON.stringify(body1.input);
    assert.ok(!input1.includes('turn01'), 'call 1: evicted turn01 absent from input');
    assert.ok(input1.includes('turn12'), 'call 1: recency tail present in input');

    // --- Call 2: SAME provider instance, grown tail, inside the
    //     cooldown — the sticky projection is RE-APPLIED. Before P1-1
    //     this was the permanent-loss turn: the evicted prefix was
    //     replaced by the projection but its checkpoint was dropped.
    await runTurn(provider, bigHistory(8));
    assert.equal(apiChatCalls.length, 1, 'call 2: NO second summarizer call (cooldown-held)');
    assert.equal(responsesCalls.length, 2, 'call 2: /v1/responses dispatched');

    const body2 = responsesCalls[1]!.body as { instructions?: string; input: unknown[] };
    assert.ok(
      body2.instructions !== undefined && body2.instructions.includes('[compacted-turns'),
      'call 2 (sticky re-apply): checkpoint still folded into instructions',
    );
    assert.ok(
      body2.instructions!.includes('CHECKPOINT SUMMARY'),
      'call 2 (sticky re-apply): checkpoint summary body present',
    );
    const input2 = JSON.stringify(body2.input);
    assert.ok(!input2.includes('turn01'), 'call 2: evicted prefix stays evicted');
    assert.ok(input2.includes('turn20'), 'call 2: grown tail appended');
  });

  it('native /api/chat is unchanged: the checkpoint rides as a system message (control)', async () => {
    configure({
      connections: [
        {
          id: 'cloud',
          type: 'cloud',
          baseUrl: BASE_URL,
          preferredEndpoint: 'native',
          contextFilter: 'safe',
        },
      ],
    });
    const ctx = makeCompactionContext();
    const provider = new OllamaCloudChatProvider(ctx);

    // --- Call 1: fire turn. Native accepts multiple system messages,
    //     so the checkpoint must appear as a `role:'system'` message in
    //     the outgoing `messages[]` exactly as before the fix.
    await runTurn(provider, bigHistory());
    assert.equal(apiChatCalls.length, 1, 'call 1: exactly one summarizer call');
    assert.equal(nativeCalls.length, 1, 'call 1: native dispatch');

    const messages1 = nativeCalls[0]!.body.messages as Array<{ role: string; content: unknown }>;
    assert.ok(
      messages1.some(
        (m) => m.role === 'system' && String(m.content).includes('[compacted-turns'),
      ),
      'call 1 (native): checkpoint present as a system message',
    );
    assert.ok(
      !JSON.stringify(messages1).includes('turn01'),
      'call 1 (native): evicted turn01 absent',
    );

    // --- Call 2: sticky re-apply — checkpoint still a system message.
    await runTurn(provider, bigHistory(8));
    assert.equal(apiChatCalls.length, 1, 'call 2: no second summarizer call');
    assert.equal(nativeCalls.length, 2, 'call 2: native dispatch');
    const messages2 = nativeCalls[1]!.body.messages as Array<{ role: string; content: unknown }>;
    assert.ok(
      messages2.some(
        (m) => m.role === 'system' && String(m.content).includes('[compacted-turns'),
      ),
      'call 2 (native, sticky re-apply): checkpoint still a system message',
    );
    assert.ok(
      !JSON.stringify(messages2).includes('turn01'),
      'call 2 (native): evicted prefix stays evicted',
    );
  });
});
