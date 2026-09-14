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
import {
  clearCapabilityProbeCache,
  probeCapabilities,
  probeModelShow,
  type ProbeContext,
} from '../../src/capabilityProbe.js';

const CLOUD_CTX: ProbeContext = { connectionId: 'cloud', rootUrl: 'https://ollama.com' };

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
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

  it('serves the second batch from cache (no re-probe)', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return jsonResponse({ capabilities: ['completion', 'vision'] });
    }) as typeof fetch;
    const ctx = { connectionId: 'test-cache', rootUrl: 'https://ollama.com' };
    const first = await probeCapabilities(['cached-model'], ctx);
    assert.equal(first.get('cached-model')?.imageInput, true);
    const firstFetchCount = fetchCount;

    const second = await probeCapabilities(['cached-model'], ctx);
    assert.equal(second.get('cached-model')?.imageInput, true);
    assert.equal(fetchCount, firstFetchCount, 'warm refresh re-probes nothing');
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
});
