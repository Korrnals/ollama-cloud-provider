/**
 * ArchCom 2026-09-14 (train B) — tests for live capability probing via
 * POST /api/show (src/capabilityProbe.ts).
 *
 * Covers the Security conditions from the architectural contract:
 *   - no Authorization header on keyless/cloud probes
 *   - Authorization sent for requiresApiKey (keyed) connections
 *   - single attempt per model (no retries on 401/404)
 *   - 429 cancels the remaining batch
 *   - strict schema validation (capabilities must be an array of strings)
 *   - response size cap
 *   - 24h cache: warm refreshes re-probe nothing
 *   - concurrency ≤ 4
 *
 * The tests stub `global.fetch` (the mocha loader sets
 * OLLAMA_HTTP_TEST_DELEGATE=1 so httpRequest delegates to it).
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  clearCapabilityProbeCache,
  probeCapabilities,
  probeModelShow,
  type ProbeContext,
} from '../../src/capabilityProbe.js';
import { logger } from '../../src/logger.js';

const CLOUD_CTX: ProbeContext = { connectionId: 'cloud', rootUrl: 'https://ollama.com' };

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Log capture — same seam as compactionOscillation.test.ts: replace the
 * vscode OutputChannel factory, force the logger singleton to re-grab its
 * channel (`setDebugMode(true)` → dispose + re-create via the patched
 * factory), and collect every appended line. `stopLogCapture` restores
 * the factory and the default channel.
 */
let capturedLogLines: string[] = [];
let originalCreateOutputChannel: typeof vscode.window.createOutputChannel | undefined;

function startLogCapture(): void {
  capturedLogLines = [];
  const capturingChannel = {
    name: 'Ollama Cloud (Debug)',
    appendLine: (line: string) => {
      capturedLogLines.push(line);
    },
    show: () => undefined,
    dispose: () => undefined,
  };
  originalCreateOutputChannel = vscode.window.createOutputChannel;
  vscode.window.createOutputChannel = (() =>
    capturingChannel) as unknown as typeof vscode.window.createOutputChannel;
  logger.setDebugMode(true);
}

function stopLogCapture(): void {
  if (originalCreateOutputChannel) {
    vscode.window.createOutputChannel = originalCreateOutputChannel;
    originalCreateOutputChannel = undefined;
  }
  logger.setDebugMode(false);
}

describe('capabilityProbe.probeModelShow (ArchCom 2026-09-14 train B)', () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    clearCapabilityProbeCache();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('maps server capabilities to imageInput/reasoning/toolCalling', async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        capabilities: ['completion', 'thinking', 'tools', 'vision'],
      });
    }) as typeof fetch;

    const outcome = await probeModelShow('glm-5.3-flash', CLOUD_CTX);
    assert.equal(outcome.source, 'api-show');
    assert.deepEqual(outcome.capabilities, {
      imageInput: true,
      reasoning: true,
      toolCalling: true,
    });
  });

  it('sends NO Authorization header for keyless (cloud) probes', async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ capabilities: ['completion'] });
    }) as typeof fetch;

    await probeModelShow('some-model', CLOUD_CTX);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, undefined, 'cloud probe must be keyless');
    assert.equal(calls[0].url, 'https://ollama.com/api/show');
  });

  it('sends Authorization for keyed (self-hosted) connections', async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ capabilities: ['completion'] });
    }) as typeof fetch;

    await probeModelShow('some-model', {
      connectionId: 'vps',
      rootUrl: 'https://vps.example.com',
      apiKey: 'sk-vps-key',
    });
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-vps-key');
  });

  it('falls back on 404 (model unknown to /api/show) — single attempt', async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ error: "model 'x' not found" }, 404);
    }) as typeof fetch;

    const outcome = await probeModelShow('missing-model', CLOUD_CTX);
    assert.equal(outcome.source, 'unavailable');
    assert.equal(outcome.capabilities, undefined);
    assert.equal(calls.length, 1, 'exactly one attempt — no retries');
  });

  it('falls back on 401 — and NEVER escalates to a keyed retry', async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ error: 'unauthorized' }, 401);
    }) as typeof fetch;

    const outcome = await probeModelShow('locked-model', CLOUD_CTX);
    assert.equal(outcome.source, 'unavailable');
    assert.equal(calls.length, 1, 'no second (keyed) attempt');
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
  });

  it('reports rate-limited on 429 (batch cancellation signal)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'rate limited' }, 429)) as typeof fetch;

    const outcome = await probeModelShow('busy-model', CLOUD_CTX);
    assert.equal(outcome.source, 'rate-limited');
    assert.equal(outcome.capabilities, undefined);
  });

  it('treats a non-array capabilities field as invalid (strict schema)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ capabilities: 'yes' })) as typeof fetch;
    const outcome = await probeModelShow('weird-model', CLOUD_CTX);
    assert.equal(outcome.source, 'invalid');
  });

  it('treats a missing capabilities field as invalid (pre-v0.6.4 server)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ details: { family: 'x' } })) as typeof fetch;
    const outcome = await probeModelShow('legacy-server-model', CLOUD_CTX);
    assert.equal(outcome.source, 'invalid');
  });

  it('rejects oversized responses (size cap)', async () => {
    globalThis.fetch = (async () => {
      const huge = { capabilities: ['completion'], padding: 'x'.repeat(70_000) };
      return jsonResponse(huge);
    }) as typeof fetch;
    const outcome = await probeModelShow('huge-model', CLOUD_CTX);
    assert.equal(outcome.source, 'invalid');
  });

  it('captures modified_at when /api/show reports it (M1)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        capabilities: ['completion'],
        modified_at: '2026-09-01T10:20:30.000Z',
      })) as typeof fetch;

    const outcome = await probeModelShow('dated-model', CLOUD_CTX);
    assert.equal(outcome.source, 'api-show');
    assert.equal(outcome.modifiedAt, '2026-09-01T10:20:30.000Z');
  });

  it('ignores a non-date modified_at value (M1)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        capabilities: ['completion'],
        modified_at: 'not-a-date',
      })) as typeof fetch;

    const outcome = await probeModelShow('garbage-date-model', CLOUD_CTX);
    assert.equal(outcome.source, 'api-show');
    assert.equal(outcome.modifiedAt, undefined);
  });

  it('rejects an oversized Content-Length WITHOUT reading the body (M3)', async () => {
    let bodyReads = 0;
    globalThis.fetch = (async () => {
      const res = jsonResponse({ capabilities: ['completion'] }, 200, {
        // Small actual body, oversized DECLARED size — proves the pre-check
        // fires on the header alone.
        'Content-Length': String(70_000),
      });
      // Response#text is typed read-only; shadow it via defineProperty so
      // the spy only fires if the probe actually reads the body.
      const originalText = res.text.bind(res);
      Object.defineProperty(res, 'text', {
        value: async () => {
          bodyReads += 1;
          return originalText();
        },
      });
      return res;
    }) as typeof fetch;

    const outcome = await probeModelShow('declared-huge-model', CLOUD_CTX);
    assert.equal(outcome.source, 'invalid');
    assert.equal(bodyReads, 0, 'body must not be read when Content-Length is oversized');
  });

  it('propagates an SSRF guard block as a throw (terminal, not a fallback)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called when the guard blocks');
    }) as typeof fetch;

    await assert.rejects(
      () =>
        probeModelShow('rebind.example', {
          ...CLOUD_CTX,
          ssrfGuard: {
            assertUrlAllowed: async () => {
              throw new Error('SsrfBlockedError: rebind.example → 169.254.169.254');
            },
          },
        }),
      /SsrfBlocked/,
    );
  });
});

describe('capabilityProbe.probeCapabilities — batch semantics', () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(() => {
    clearCapabilityProbeCache();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('cancels the remaining batch on the first 429', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requested.push(body.model);
      if (body.model === 'model-a') {
        // Instant 429 on the first model — the other in-flight probes
        // resolve later, so the cancellation flag is set before any
        // worker can pick up model-e.
        return jsonResponse({ error: 'rate limited' }, 429);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return jsonResponse({ capabilities: ['completion'] });
    }) as typeof fetch;

    const result = await probeCapabilities(
      ['model-a', 'model-b', 'model-c', 'model-d', 'model-e'],
      { connectionId: 'test-batch', rootUrl: 'https://ollama.com' },
    );

    // The four workers started a..d before the instant 429 landed; the
    // fifth model must NEVER be requested (batch cancelled). The three
    // probes already in flight complete and are kept ("keep what was
    // collected" — contract semantics); the 429'd model records nothing.
    assert.ok(!requested.includes('model-e'), `requested=${requested.join(',')}`);
    assert.equal(result.has('model-a'), false, 'the rate-limited model is absent');
    assert.ok(result.has('model-b') && result.has('model-c') && result.has('model-d'));
  });

  it('benches the connection after a 429 — the next batch does not fetch (M2)', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return jsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '600' });
    }) as typeof fetch;

    const ctx: ProbeContext = { connectionId: 'test-429', rootUrl: 'https://ollama.com' };
    const first = await probeCapabilities(['model-x'], ctx);
    assert.equal(first.size, 0);
    assert.equal(fetchCount, 1, 'first batch probed once');

    // Same connection while benched: skipped entirely — no fetch.
    const second = await probeCapabilities(['model-y', 'model-z'], ctx);
    assert.equal(second.size, 0);
    assert.equal(fetchCount, 1, 'benched connection must not fetch again');

    // The bench is per-connection: a different connectionId still probes.
    await probeCapabilities(['model-w'], { ...ctx, connectionId: 'test-429-other' });
    assert.equal(fetchCount, 2, 'other connections are not benched');
  });

  it('serves the second batch from cache (no re-probe)', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return jsonResponse({ capabilities: ['completion', 'vision'] });
    }) as typeof fetch;
    const ctx = { connectionId: 'test-cache', rootUrl: 'https://ollama.com' };
    const first = await probeCapabilities(['cached-model'], ctx);
    assert.equal(first.get('cached-model')?.capabilities.imageInput, true);
    const firstFetchCount = fetchCount;

    const second = await probeCapabilities(['cached-model'], ctx);
    assert.equal(second.get('cached-model')?.capabilities.imageInput, true);
    assert.equal(fetchCount, firstFetchCount, 'warm refresh re-probes nothing');
  });

  it('keeps modified_at through the batch result and the 24h cache (M1)', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return jsonResponse({
        capabilities: ['completion'],
        modified_at: '2026-08-31T08:00:00.000Z',
      });
    }) as typeof fetch;
    const ctx = { connectionId: 'test-m1', rootUrl: 'https://ollama.com' };

    const first = await probeCapabilities(['m1-model'], ctx);
    assert.equal(first.get('m1-model')?.modifiedAt, '2026-08-31T08:00:00.000Z');

    // Cache round-trip: the warm batch serves modifiedAt without a fetch.
    const second = await probeCapabilities(['m1-model'], ctx);
    assert.equal(fetchCount, 1);
    assert.equal(second.get('m1-model')?.modifiedAt, '2026-08-31T08:00:00.000Z');
  });

  it('limits concurrency to 4', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return jsonResponse({ capabilities: ['completion'] });
    }) as typeof fetch;

    const result = await probeCapabilities(
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
      { connectionId: 'test-conc', rootUrl: 'https://ollama.com' },
    );

    assert.equal(result.size, 8);
    assert.ok(maxInFlight <= 4, `maxInFlight=${maxInFlight} must be ≤ 4`);
  });
});

describe('capabilityProbe — catalog integration auth (Security gate B1 regression)', () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(() => {
    clearCapabilityProbeCache();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function conn(overrides: Record<string, unknown>): import('../../src/connections.js').ConnectionConfig {
    return {
      id: 'x',
      label: 'X',
      type: 'custom',
      enabled: true,
      baseUrl: 'https://x.example.com/v1',
      openaiCompatiblePath: '',
      allowedBaseUrls: ['https://x.example.com/v1'],
      visionModels: [],
      requiresApiKey: false,
      preferredEndpoint: 'auto',
      contextFilter: 'auto',
      ...overrides,
    } as import('../../src/connections.js').ConnectionConfig;
  }

  it('cloud probes stay keyless even though cloud requiresApiKey=true; keyed remotes send the key', async () => {
    const showCalls: Array<{ url: string; authorization: string | undefined; model: string }> = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/show')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const body = JSON.parse(String(init?.body)) as { model: string };
        showCalls.push({ url, authorization: headers.Authorization, model: body.model });
        return jsonResponse({ capabilities: ['completion', 'vision'] });
      }
      // Catalog lists per connection host.
      if (url.startsWith('https://ollama.com/')) {
        return jsonResponse({ data: [{ id: 'brand-new-cloud-model' }] });
      }
      if (url.startsWith('https://example.com/')) {
        return jsonResponse({ data: [{ id: 'brand-new-vps-model' }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const auth = {
      getApiKey: async () => 'sk-cloud-key',
      // IMPORTANT: returns a key for cloud too — the catalog must NOT
      // use it for cloud probes (gate on type, not on the flag).
      getApiKeyForConnection: async (c: { id: string }) =>
        c.id === 'cloud' ? 'sk-cloud-key' : 'sk-vps-key',
      getBaseUrl: () => 'https://ollama.com/v1',
      getRootUrl: () => 'https://ollama.com',
    };
    const { ModelCatalog } = await import('../../src/modelCatalog.js');
    const catalog = new ModelCatalog(auth as never);

    await catalog.refreshForConnections([
      conn({
        id: 'cloud',
        type: 'cloud',
        label: 'Cloud',
        baseUrl: 'https://ollama.com/v1',
        allowedBaseUrls: ['https://ollama.com/v1'],
        requiresApiKey: true,
      }),
      conn({
        id: 'vps',
        type: 'remote',
        label: 'VPS',
        baseUrl: 'https://example.com/v1',
        allowedBaseUrls: ['https://example.com/v1'],
        requiresApiKey: true,
      }),
    ]);

    const cloudProbe = showCalls.find((c) => c.url.startsWith('https://ollama.com/'));
    const vpsProbe = showCalls.find((c) => c.url.startsWith('https://example.com/'));
    assert.ok(cloudProbe, 'cloud model was probed');
    assert.ok(vpsProbe, 'vps model was probed');
    assert.equal(cloudProbe.authorization, undefined, 'cloud probe must be keyless (gate B1)');
    assert.equal(cloudProbe.model, 'brand-new-cloud-model');
    assert.equal(vpsProbe.authorization, 'Bearer sk-vps-key', 'keyed remote sends its key');
  });

  it('batch log carries oldestCached=HH:MM:SS when /api/show reports modified_at (M1)', async () => {
    startLogCapture();
    try {
      globalThis.fetch = (async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/show')) {
          return jsonResponse({
            capabilities: ['completion', 'vision'],
            modified_at: '2026-08-01T09:08:07.000Z',
          });
        }
        if (url.endsWith('/v1/models')) {
          return jsonResponse({ data: [{ id: 'dated-new-model' }] });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      const auth = {
        getApiKey: async () => 'sk-cloud-key',
        getApiKeyForConnection: async () => 'sk-cloud-key',
        getBaseUrl: () => 'https://ollama.com/v1',
        getRootUrl: () => 'https://ollama.com',
      };
      const { ModelCatalog } = await import('../../src/modelCatalog.js');
      const catalog = new ModelCatalog(auth as never);

      await catalog.refreshForConnections([
        conn({
          id: 'cloud',
          type: 'cloud',
          label: 'Cloud',
          baseUrl: 'https://ollama.com/v1',
          allowedBaseUrls: ['https://ollama.com/v1'],
          requiresApiKey: true,
        }),
      ]);

      const line = capturedLogLines.find((l) =>
        l.includes("capability-probe: connection='cloud'"),
      );
      assert.ok(line, 'batch log line emitted');
      assert.ok(
        line.includes('oldestCached=09:08:07'),
        `oldestCached HH:MM:SS missing: ${line}`,
      );
    } finally {
      stopLogCapture();
    }
  });

  it('batch log carries oldestCached=- when no modified_at is reported (M1)', async () => {
    startLogCapture();
    try {
      globalThis.fetch = (async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/show')) {
          return jsonResponse({ capabilities: ['completion'] });
        }
        if (url.endsWith('/v1/models')) {
          return jsonResponse({ data: [{ id: 'undated-new-model' }] });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      const auth = {
        getApiKey: async () => 'sk-cloud-key',
        getApiKeyForConnection: async () => 'sk-cloud-key',
        getBaseUrl: () => 'https://ollama.com/v1',
        getRootUrl: () => 'https://ollama.com',
      };
      const { ModelCatalog } = await import('../../src/modelCatalog.js');
      const catalog = new ModelCatalog(auth as never);

      await catalog.refreshForConnections([
        conn({
          id: 'cloud',
          type: 'cloud',
          label: 'Cloud',
          baseUrl: 'https://ollama.com/v1',
          allowedBaseUrls: ['https://ollama.com/v1'],
          requiresApiKey: true,
        }),
      ]);

      const line = capturedLogLines.find((l) =>
        l.includes("capability-probe: connection='cloud'"),
      );
      assert.ok(line, 'batch log line emitted');
      assert.ok(line.includes('oldestCached=-'), `oldestCached=- missing: ${line}`);
    } finally {
      stopLogCapture();
    }
  });
});
