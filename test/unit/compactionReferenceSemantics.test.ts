import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import type { OllamaClient } from '../../src/ollamaClient.js';
import type { ModelDefinition } from '../../src/modelCatalog.js';
import type { OpenAICompatibleMessage } from '../../src/protocolTypes.js';

/**
 * v0220-t (A-review follow-up) — the maybeCompact REFERENCE contract,
 * pinned directly. The v0220-a dispatch gate distinguishes "compaction
 * shaped the history" by ARRAY IDENTITY (a NEW reference means the
 * fire/re-apply shape must flow through the shaped converters; the SAME
 * reference keeps the original VS Code conversion paths byte-for-byte).
 * This is the lone identity-regression detector: a copy-on-passthrough
 * regression here silently reroutes every below-threshold request.
 *
 * Contract:
 *   - SAME reference on every passthrough path: compaction disabled /
 *     unknown window / no store / summarizer failure / clean
 *     below-threshold passthrough;
 *   - NEW reference on a fire and on a sticky re-apply.
 *
 * `maybeCompact` is private (provider wiring detail); these tests reach
 * it through a minimal typed cast instead of a full
 * `provideLanguageModelChatResponse` dispatch, which would observe the
 * same property far more expensively.
 */

type MaybeCompact = (
  openaiMessages: OpenAICompatibleMessage[],
  model: ModelDefinition,
  modelId: string,
  client: OllamaClient,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
) => Promise<OpenAICompatibleMessage[]>;

function maybeCompactOf(provider: OllamaCloudChatProvider): MaybeCompact {
  return (provider as unknown as { maybeCompact: MaybeCompact }).maybeCompact.bind(provider);
}

const storageDirs: string[] = [];

function makeContext(storage = true): vscode.ExtensionContext {
  const secrets = new Map<string, string | undefined>();
  const storageDir = storage
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'ocp-ref-semantics-'))
    : '';
  if (storage) storageDirs.push(storageDir);
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
    globalStorageUri: {
      toString: () => `file://${storageDir}`,
      fsPath: storageDir,
    },
  } as unknown as vscode.ExtensionContext;
}

const MODEL: ModelDefinition = {
  id: 'gpt-oss:120b',
  apiModel: 'gpt-oss:120b',
  name: 'gpt-oss:120b',
  family: 'test',
  version: 'test',
  detail: 'test model',
  connectionId: 'cloud',
  origin: 'Cloud',
  maxInputTokens: 131_072,
  maxOutputTokens: 32_768,
  reasoning: false,
  capabilities: { imageInput: false, toolCalling: true },
} as unknown as ModelDefinition;

const MODEL_UNKNOWN_WINDOW: ModelDefinition = { ...MODEL, maxInputTokens: 0 };

function fakeClient(impl?: () => Promise<string>): { client: OllamaClient; calls: () => number } {
  const calls = { count: 0 };
  const client = {
    nativeChatOnce: async (): Promise<string> => {
      calls.count++;
      if (impl) return impl();
      return 'CHECKPOINT SUMMARY';
    },
  } as unknown as OllamaClient;
  return { client, calls: () => calls.count };
}

function clientWhoseSummarizerFails(): OllamaClient {
  return {
    nativeChatOnce: async (): Promise<string> => {
      throw new Error('summarizer model overloaded');
    },
  } as unknown as OllamaClient;
}

const progress: vscode.Progress<vscode.LanguageModelResponsePart> = { report: () => undefined };

const PAD = 36_000;

/** 12 two-message turns ≈ 216k estimated tokens — over the 98304 (75%) threshold. */
function bigHistory(extraTurns = 0): OpenAICompatibleMessage[] {
  const msgs: OpenAICompatibleMessage[] = [];
  for (let i = 1; i <= 12 + extraTurns; i++) {
    const tag = `turn${String(i).padStart(2, '0')}`;
    msgs.push({ role: 'user', content: `${tag}u ` + 'x'.repeat(PAD) });
    msgs.push({ role: 'assistant', content: `${tag}a ` + 'x'.repeat(PAD) });
  }
  return msgs;
}

function smallHistory(): OpenAICompatibleMessage[] {
  return [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'bye' },
  ];
}

describe('maybeCompact reference semantics (v0220-t A-review follow-up)', () => {
  beforeEach(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: 'https://ollama.com/v1', preferredEndpoint: 'chat' },
      ],
    });
  });

  afterEach(() => {
    for (const dir of storageDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the SAME array reference on every passthrough path', async () => {
    // (1) compaction disabled — explicit opt-out (`_replace` swaps the
    //     whole store, so the full topology rides along).
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'cloud', type: 'cloud', baseUrl: 'https://ollama.com/v1', preferredEndpoint: 'chat' },
      ],
      'compaction.enabled': false,
    });
    {
      const provider = new OllamaCloudChatProvider(makeContext());
      const input = smallHistory();
      const { client } = fakeClient();
      const out = await maybeCompactOf(provider)(input, MODEL, 'ollama-cloud/gpt-oss:120b', client, progress);
      assert.strictEqual(out, input, 'disabled: SAME reference');
    }

    // (2) unknown window — ArchCom invariant 4 safe path.
    {
      const provider = new OllamaCloudChatProvider(makeContext());
      const input = bigHistory();
      const { client, calls } = fakeClient();
      const out = await maybeCompactOf(provider)(input, MODEL_UNKNOWN_WINDOW, 'ollama-cloud/gpt-oss:120b', client, progress);
      assert.strictEqual(out, input, 'unknown window: SAME reference');
      assert.equal(calls(), 0, 'unknown window: summarizer never called');
    }

    // (3) no store — globalStorage unavailable (mock contexts).
    {
      const provider = new OllamaCloudChatProvider(makeContext(false));
      const input = bigHistory();
      const { client, calls } = fakeClient();
      const out = await maybeCompactOf(provider)(input, MODEL, 'ollama-cloud/gpt-oss:120b', client, progress);
      assert.strictEqual(out, input, 'no store: SAME reference');
      assert.equal(calls(), 0, 'no store: summarizer never called');
    }

    // (4) summarizer failure — fallback contract (compaction never
    //     fails the chat): the catch/!compacted paths hand back the
    //     ORIGINAL array, not a defensive copy.
    {
      const provider = new OllamaCloudChatProvider(makeContext());
      const input = bigHistory();
      const out = await maybeCompactOf(provider)(input, MODEL, 'ollama-cloud/gpt-oss:120b', clientWhoseSummarizerFails(), progress);
      assert.strictEqual(out, input, 'summarizer failure: SAME reference');
    }

    // (5) clean below-threshold passthrough — everything enabled, the
    //     common case for default users who never hit 75%.
    {
      const provider = new OllamaCloudChatProvider(makeContext());
      const input = smallHistory();
      const { client, calls } = fakeClient();
      const out = await maybeCompactOf(provider)(input, MODEL, 'ollama-cloud/gpt-oss:120b', client, progress);
      assert.strictEqual(out, input, 'below threshold: SAME reference');
      assert.equal(calls(), 0, 'below threshold: summarizer never called');
    }
  });

  it('returns a NEW array reference on a fire and on a sticky re-apply', async () => {
    const provider = new OllamaCloudChatProvider(makeContext());
    const { client, calls } = fakeClient();

    // Fire: the assembled [system…, pinned…, summary, recency…] array
    // is a NEW reference — the dispatch gate must route it through the
    // shaped converters.
    const fireInput = bigHistory();
    const fired = await maybeCompactOf(provider)(fireInput, MODEL, 'ollama-cloud/gpt-oss:120b', client, progress);
    assert.notStrictEqual(fired, fireInput, 'fire: NEW reference');
    assert.equal(calls(), 1, 'fire: exactly one summarizer call');
    assert.ok(
      fired.some((m) => m.role === 'system' && String(m.content).startsWith('[compacted-turns')),
      'fire: the injected checkpoint is present',
    );

    // Sticky re-apply (grown tail, within the cooldown): the projection
    // array is likewise a NEW reference — it must be SERVED, not
    // silently swapped for the raw input.
    const grownTail: OpenAICompatibleMessage = { role: 'user', content: 'final question' };
    const grownInput = [...bigHistory(), grownTail];
    const reapplied = await maybeCompactOf(provider)(grownInput, MODEL, 'ollama-cloud/gpt-oss:120b', client, progress);
    assert.notStrictEqual(reapplied, grownInput, 'sticky re-apply: NEW reference');
    assert.equal(calls(), 1, 'sticky re-apply: NO second summarizer call');
    assert.ok(
      reapplied.some((m) => m.role === 'system' && String(m.content).startsWith('[compacted-turns')),
      'sticky re-apply: the checkpoint is re-served',
    );
    assert.ok(
      !reapplied.some((m) => String(m.content).includes('turn01u ')),
      'sticky re-apply: the evicted prefix stays evicted',
    );
  });
});
