import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  executeTwoPhaseVision,
  clearImageDescriptionCache,
  setVisionCachePath,
  sha256ShortHex,
} from '../../src/visionTwoPhase.js';
import type { ModelDefinition } from '../../src/modelCatalog.js';
import type { ConnectionConfig } from '../../src/connections.js';

/**
 * Two-phase vision description-cache tests (v0.13.0 follow-up).
 *
 * Owner directive 2026-08-20: after the vision model finishes
 * describing an image, control returns IMMEDIATELY to the primary
 * model. On subsequent turns where the same image is still in the
 * VS Code-owned history (re-sent every turn) but the CURRENT turn
 * carries no new image, the fallback must NOT re-run the vision
 * model — the cached description is substituted silently.
 *
 * Covers:
 *   - first turn: new image → 1 vision call, annotation fired,
 *     description replaces the image part
 *   - second turn (same image in history, no new image): 0 vision
 *     calls, NO annotation, cached description substituted
 *   - uncached image is described per-image: two images → two calls
 */

const { LanguageModelDataPart, LanguageModelTextPart, LanguageModelChatMessageRole } =
  vscode;

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

function makeModel(
  id: string,
  connectionId: string,
  imageInput: boolean,
): ModelDefinition {
  return {
    id,
    apiModel: id.split('/').pop() ?? id,
    name: id,
    family: 'test',
    version: 'test',
    detail: 'test',
    connectionId,
    origin: 'Cloud',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    reasoning: false,
    capabilities: { imageInput, toolCalling: true },
  };
}

function makeConnection(id: string): ConnectionConfig {
  return {
    id,
    label: id,
    type: 'cloud',
    enabled: true,
    // Same host as the existing pass-through tests: `ollama.com`
    // resolves publicly, so the production SSRF guard's DNS check
    // passes and the mocked fetch intercepts the actual request.
    baseUrl: 'https://ollama.com/v1',
    openaiCompatiblePath: '',
    allowedBaseUrls: ['https://ollama.com/v1'],
    visionModels: [],
    requiresApiKey: true,
    preferredEndpoint: 'auto',
    contextFilter: 'auto',
  };
}

function textMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(text)],
    name: undefined,
  };
}

function imageMsg(
  bytes: number[],
  text = 'what is this?',
): vscode.LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: [
      new LanguageModelTextPart(text),
      new LanguageModelDataPart(new Uint8Array(bytes), 'image/png'),
    ] as unknown as vscode.LanguageModelChatRequestMessage['content'],
    name: undefined,
  };
}

/** PNG-magic test images (distinct bytes → distinct hashes). */
const IMG_A = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMG_B = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];

describe('visionTwoPhase description cache', () => {
  beforeEach(() => {
    clearImageDescriptionCache();
    setVisionCachePath(null);
    setConfig({});
  });

  afterEach(() => {
    clearImageDescriptionCache();
    setVisionCachePath(null);
    setConfig({});
  });

  it('first turn: new image → vision call fires, annotation shown, image replaced by description', async () => {
    const primary = makeModel('cloud/glm-5.2', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    const annotations: string[] = [];
    const visionCalls: Array<Array<{ role: string; content: string; images?: string[] }>> =
      [];

    // Mock nativeChatOnce via global fetch — one call per image.
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      const body = (input as Request).json
        ? await (input as Request).json()
        : JSON.parse(String((input as { _body?: string })._body ?? '{}'));
      visionCalls.push(body.messages);
      return new Response(
        JSON.stringify({ message: { content: 'a test screenshot' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const result = await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages: [imageMsg(IMG_A)],
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: {
          report: (part: vscode.LanguageModelResponsePart) => {
            if (part instanceof vscode.LanguageModelTextPart) {
              annotations.push(part.value);
            }
          },
        },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
      });

      // Exactly ONE vision call for ONE image.
      assert.equal(visionCalls.length, 1, 'one vision call for one image');
      // Annotation fired (new image → not silent).
      assert.ok(
        annotations.some((a) => a.includes('Describing image')),
        'annotation fired on first turn',
      );
      // The image part was replaced with the wrapped description.
      const flat = result.messages.flatMap((m) =>
        m.role === vscode.LanguageModelChatMessageRole.User
          ? m.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : 'IMG'))
          : [],
      );
      assert.ok(
        flat.some((v) => v.includes('[Image description from')),
        'description replaced the image part',
      );
      assert.ok(
        !flat.includes('IMG'),
        'no raw image part left in rewritten history',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('second turn, same image in history, no new image: ZERO vision calls, NO annotation, cached description substituted', async () => {
    const primary = makeModel('cloud/glm-5.2', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    const annotations: string[] = [];
    let visionCallCount = 0;

    // Pre-seed the cache — as if turn 1 already described IMG_A.
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      return new Response(
        JSON.stringify({ message: { content: 'a test screenshot' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      // Turn 1 — populates the cache.
      await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages: [imageMsg(IMG_A)],
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: {
          report: () => {
            /* collected via annotations array below */
          },
        },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
      });
      assert.equal(visionCallCount, 1, 'turn 1: one vision call');
      annotations.length = 0;

      // Turn 2 — SAME image in history + new text-only user message.
      // The gate still fires (image in payload, primary non-vision),
      // but the cache must make it SILENT: 0 new vision calls.
      const history = [
        imageMsg(IMG_A),
        { role: vscode.LanguageModelChatMessageRole.Assistant, content: 'got it' },
        textMsg('and what about the layout?'),
      ] as vscode.LanguageModelChatRequestMessage[];

      const result2 = await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages: history,
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: {
          report: (part: vscode.LanguageModelResponsePart) => {
            if (part instanceof vscode.LanguageModelTextPart) {
              annotations.push(part.value);
            }
          },
        },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
      });

      // ZERO additional vision calls — the core of the owner directive.
      assert.equal(
        visionCallCount,
        1,
        'turn 2: NO additional vision call (cache hit)',
      );
      // NO annotation — control passes straight to the primary model.
      assert.equal(
        annotations.length,
        0,
        'turn 2: no Describing-image annotation (silent cache substitution)',
      );
      // The cached description IS in the rewritten history.
      const flat2 = result2.messages.flatMap((m) =>
        m.role === vscode.LanguageModelChatMessageRole.User
          ? m.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : 'IMG'))
          : [],
      );
      assert.ok(
        flat2.some((v) => v.includes('[Image description from')),
        'turn 2: cached description substituted in history',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('cache survives a simulated extension reload (file persistence)', async () => {
    const cacheFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vision-cache-')),
      'vision-description-cache.json',
    );
    const primary = makeModel('cloud/glm-5.2', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    const annotations: string[] = [];
    let visionCallCount = 0;

    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      return new Response(
        JSON.stringify({ message: { content: 'a persisted screenshot' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const run = async (): Promise<void> => {
        await executeTwoPhaseVision({
          primaryModel: primary,
          primaryConnection: connection,
          messages: [imageMsg(IMG_A)],
          options: {} as vscode.ProvideLanguageModelChatResponseOptions,
          progress: {
            report: (part: vscode.LanguageModelResponsePart) => {
              if (part instanceof vscode.LanguageModelTextPart) {
                annotations.push(part.value);
              }
            },
          },
          token: new vscode.CancellationTokenSource().token,
          authManager: {
            getApiKeyForConnection: async () => 'sk-test',
            getApiKey: async () => 'sk-test',
            getBaseUrl: () => 'https://ollama.com/v1',
          } as never,
          catalog: [primary, vision],
          connections: [connection],
        });
      };

      // "Session 1": describe the image, persist the cache file.
      setVisionCachePath(cacheFile);
      await run();
      assert.equal(visionCallCount, 1, 'session 1: one vision call');
      assert.ok(fs.existsSync(cacheFile), 'cache file written');
      // Atomic write: the temp sibling must be gone after rename, and
      // the persisted file must parse as complete JSON.
      assert.ok(
        !fs.existsSync(`${cacheFile}.tmp`),
        'no .tmp leftover after atomic persist',
      );
      assert.ok(
        typeof JSON.parse(fs.readFileSync(cacheFile, 'utf8')) === 'object',
        'persisted cache is complete JSON',
      );

      // "Window reload": in-memory cache dies (module state reset),
      // activation hydrates from the file.
      clearImageDescriptionCache();
      annotations.length = 0;
      setVisionCachePath(cacheFile);

      // "Session 2": same image in re-sent history → cache hit, no
      // vision call, no annotation.
      await run();
      assert.equal(
        visionCallCount,
        1,
        'session 2 (post-reload): NO vision call — cache hydrated from file',
      );
      assert.equal(
        annotations.length,
        0,
        'session 2 (post-reload): no annotation — silent substitution',
      );
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    }
  });

  it('two distinct images → two vision calls, both cached', async () => {
    const primary = makeModel('cloud/glm-5.2', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    let visionCallCount = 0;

    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      return new Response(
        JSON.stringify({ message: { content: 'an image' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const messages = [imageMsg(IMG_A, 'first'), imageMsg(IMG_B, 'second')];
      const result = await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages,
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: { report: () => undefined },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
      });

      assert.equal(visionCallCount, 2, 'two distinct images → two vision calls');
      const userTexts = result.messages
        .filter((m) => m.role === vscode.LanguageModelChatMessageRole.User)
        .flatMap((m) => m.content)
        .filter(
          (p): p is vscode.LanguageModelTextPart =>
            p instanceof vscode.LanguageModelTextPart,
        )
        .map((p) => p.value);
      const descriptionCount = userTexts.filter((v) =>
        v.includes('[Image description from'),
      ).length;
      assert.equal(descriptionCount, 2, 'both images replaced with descriptions');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

/**
 * v0.22.3 (task v0223-vision-cache-warm, D2) — the ledger-aware
 * text-only gate. When the describe WOULD fire for a hash the
 * TurnLedger already committed as sent this session (a vision-capable
 * primary served it RAW on an earlier turn, then the user switched to
 * a text-only primary and VS Code re-sends the immutable history), the
 * two-phase path must NOT describe: the persistent cache wins when the
 * D1 warm-up already filled it; otherwise the hash substitutes the
 * standard repeat marker. Never a fresh describe, never a throw.
 * Truly NEW hashes (never committed) keep the byte-identical
 * describe-or-throw contract — asserted by the pin that a probe that
 * says "not sent" still describes.
 */
describe('visionTwoPhase ledger-aware marker (v0.22.3 D2)', () => {
  beforeEach(() => {
    clearImageDescriptionCache();
    setVisionCachePath(null);
    setConfig({});
  });

  afterEach(() => {
    clearImageDescriptionCache();
    setVisionCachePath(null);
    setConfig({});
  });

  it('sent hash + warm cache present → cached description substitutes SILENTLY (no vision call)', async () => {
    const primary = makeModel('cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    let visionCallCount = 0;
    const annotations: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      return new Response(
        JSON.stringify({ message: { content: 'x' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      // Pre-warm the cache (the D1 warm-up completed fast).
      const { warmImageDescriptionCache } = await import('../../src/visionTwoPhase.js');
      await warmImageDescriptionCache({
        visionModel: vision,
        visionConnection: connection,
        apiKey: 'sk-test',
        baseUrl: 'https://ollama.com/v1',
        images: new Map([[sha256ShortHex(new Uint8Array(IMG_A)), Buffer.from(IMG_A).toString('base64')]]),
        token: new vscode.CancellationTokenSource().token,
      });
      assert.equal(visionCallCount, 1, 'warm-up performed one describe');
      const result = await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages: [imageMsg(IMG_A), textMsg('and the layout?')],
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: {
          report: (part: vscode.LanguageModelResponsePart) => {
            if (part instanceof vscode.LanguageModelTextPart) {
              annotations.push(part.value);
            }
          },
        },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
        sentHashProbe: (hash) => hash === sha256ShortHex(new Uint8Array(IMG_A)),
      });
      assert.equal(visionCallCount, 1, 'sent hash resolved from the warm cache — no describe call');
      assert.equal(annotations.length, 0, 'no Describing-image annotation (silent)');
      const flat = result.messages
        .filter((m) => m.role === vscode.LanguageModelChatMessageRole.User)
        .flatMap((m) => m.content)
        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
        .map((p) => p.value);
      assert.ok(
        flat.some((v) => v.includes('[Image description from')),
        'the real description beat the marker (cache wins)',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('sent hash + NO warm cache → repeat marker substituted, ZERO describe calls, no throw', async () => {
    const primary = makeModel('cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    let visionCallCount = 0;
    const annotations: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      throw new Error('vision endpoint must not be called for a sent hash');
    }) as typeof fetch;
    try {
      const result = await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages: [imageMsg(IMG_A), textMsg('and the layout?')],
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: {
          report: (part: vscode.LanguageModelResponsePart) => {
            if (part instanceof vscode.LanguageModelTextPart) {
              annotations.push(part.value);
            }
          },
        },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
        sentHashProbe: (hash) => hash === sha256ShortHex(new Uint8Array(IMG_A)),
      });
      assert.equal(visionCallCount, 0, 'NO describe call for a sent hash (marker path)');
      assert.equal(annotations.length, 0, 'no Describing-image annotation');
      const flat = result.messages
        .filter((m) => m.role === vscode.LanguageModelChatMessageRole.User)
        .flatMap((m) => m.content)
        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
        .map((p) => p.value);
      const marker = flat.find((v) => v.includes('[Image '));
      assert.ok(marker, 'a marker text part replaced the image');
      assert.ok(marker.includes('duplicate of an image already sent'), 'standard MARKER_TEMPLATE shape');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('never-sent hash with sentHashProbe wired → the describe contract is UNCHANGED (still describes)', async () => {
    const primary = makeModel('cloud/gpt-oss:120b', 'cloud', false);
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    let visionCallCount = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      return new Response(
        JSON.stringify({ message: { content: 'a fresh image' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      await executeTwoPhaseVision({
        primaryModel: primary,
        primaryConnection: connection,
        messages: [imageMsg(IMG_A)],
        options: {} as vscode.ProvideLanguageModelChatResponseOptions,
        progress: { report: () => undefined },
        token: new vscode.CancellationTokenSource().token,
        authManager: {
          getApiKeyForConnection: async () => 'sk-test',
          getApiKey: async () => 'sk-test',
          getBaseUrl: () => 'https://ollama.com/v1',
        } as never,
        catalog: [primary, vision],
        connections: [connection],
        // A real provider probe — but IMG_A was never committed anywhere.
        sentHashProbe: () => false,
      });
      assert.equal(visionCallCount, 1, 'a never-sent hash keeps the describe contract');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('warmImageDescriptionCache: skips hashes already in the cache and an empty image map (no fetch)', async () => {
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    let visionCallCount = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      visionCallCount += 1;
      return new Response(
        JSON.stringify({ message: { content: 'a test screenshot' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const { warmImageDescriptionCache } = await import('../../src/visionTwoPhase.js');
      await warmImageDescriptionCache({
        visionModel: vision,
        visionConnection: connection,
        apiKey: 'sk-test',
        baseUrl: 'https://ollama.com/v1',
        images: new Map([[sha256ShortHex(new Uint8Array(IMG_A)), Buffer.from(IMG_A).toString('base64')]]),
        token: new vscode.CancellationTokenSource().token,
      });
      assert.equal(visionCallCount, 1);
      // Repeat: the hash is already in the cache — skip entirely.
      await warmImageDescriptionCache({
        visionModel: vision,
        visionConnection: connection,
        apiKey: 'sk-test',
        baseUrl: 'https://ollama.com/v1',
        images: new Map([[sha256ShortHex(new Uint8Array(IMG_A)), Buffer.from(IMG_A).toString('base64')]]),
        token: new vscode.CancellationTokenSource().token,
      });
      assert.equal(visionCallCount, 1, 'already-cached hash did not re-fetch');
      // Empty map → no call at all.
      await warmImageDescriptionCache({
        visionModel: vision,
        visionConnection: connection,
        apiKey: 'sk-test',
        baseUrl: 'https://ollama.com/v1',
        images: new Map(),
        token: new vscode.CancellationTokenSource().token,
      });
      assert.equal(visionCallCount, 1, 'empty image map → no call');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('warmImageDescriptionCache: describe failure → cache NOT poisoned (throw-and-never-cache)', async () => {
    const vision = makeModel('cloud/minimax-m3', 'cloud', true);
    const connection = makeConnection('cloud');
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/chat')) {
        return new Response('[]', { status: 200 });
      }
      return new Response('vision upstream overloaded', { status: 500 });
    }) as typeof fetch;
    try {
      const { warmImageDescriptionCache } = await import('../../src/visionTwoPhase.js');
      await assert.rejects(
        () =>
          warmImageDescriptionCache({
            visionModel: vision,
            visionConnection: connection,
            apiKey: 'sk-test',
            baseUrl: 'https://ollama.com/v1',
            images: new Map([[sha256ShortHex(new Uint8Array(IMG_A)), Buffer.from(IMG_A).toString('base64')]]),
            token: new vscode.CancellationTokenSource().token,
          }),
        /vision model call failed/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
