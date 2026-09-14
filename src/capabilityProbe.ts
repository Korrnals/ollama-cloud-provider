/**
 * ArchCom 2026-09-14 (train B) — live capability probing via the native
 * `POST /api/show` endpoint.
 *
 * The cloud's model LIST endpoints (`/v1/models`, `/api/tags`) carry no
 * capability metadata, so new vision models were misdetectected as
 * text-only until a hardcoded snapshot entry shipped (the glm-5.3-flash
 * bug). `/api/show` returns the authoritative per-model `capabilities`
 * array (e.g. `["completion","thinking","tools","vision"]`), live-verified
 * on ollama.com 2026-09-14 — public, no auth required on the cloud.
 *
 * Security conditions (ArchCom contract §3.3, mandatory):
 *   - Authorization: NOT sent for the cloud connection (public endpoint —
 *     sending the key would only tie probe traffic to the account and
 *     expose it to logging proxies). Self-hosted connections with
 *     `requiresApiKey` send the key, exactly as `/v1/models` does.
 *     A 401/403 probe result NEVER escalates to key-based retry.
 *   - One attempt per model, NO withRetry. Probe failure degrades to the
 *     snapshot/heuristic fallback — discovery must not fail because a
 *     probe did.
 *   - 429: honor it — cancel the whole batch, keep what was collected.
 *   - Strict schema validation: `capabilities` must be an array of
 *     strings; anything else is treated as "no data" (fallback).
 *   - Response size cap: /api/show replies are a few KB; anything over
 *     64 KiB is rejected as hostile/misrouted.
 *   - Concurrency ≤ 4, single-flight per batch.
 *   - Trust: probe results only ELEVATE from the name heuristics
 *     (server-true wins); server-false never silently demotes a
 *     heuristic-true — the disagreement is logged instead (contract
 *     trust-rules; the user override `visionModels` stays senior at
 *     runtime via resolveVisionSupport).
 */

import { httpRequest } from './httpClient.js';
import { logger } from './logger.js';

/** Capabilities we consume from the server's `capabilities` array. */
export interface ProbedCapabilities {
  imageInput: boolean;
  reasoning: boolean;
  toolCalling: boolean;
}

/**
 * Per-model probe outcome. `capabilities` is present only on a successful,
 * schema-valid 2xx response; every other case means "fall back to
 * snapshot/heuristics" (`source` explains why, for diagnostics).
 */
export interface ProbeOutcome {
  apiModel: string;
  capabilities?: ProbedCapabilities;
  source: 'api-show' | 'unavailable' | 'invalid' | 'rate-limited';
}

/** Connection-scoped context for a probe batch. */
export interface ProbeContext {
  /** Cache/identity key — the owning connection id ('cloud' for cloud). */
  connectionId: string;
  /** Root URL for the native API (`.../api/show` is appended). */
  rootUrl: string;
  /**
   * API key for self-hosted connections with `requiresApiKey`. When
   * undefined (cloud, or keyless local), no Authorization header is sent.
   */
  apiKey?: string;
  /**
   * Security condition — DNS-rebinding SSRF guard, same layering as the
   * catalog fetches: assertUrlAllowed(url) runs right before the POST.
   * A blocked URL THROWS (terminal) — a security block must not be
   * silently swallowed into a capabilities fallback; the caller catches
   * and logs it without failing the whole refresh.
   */
  ssrfGuard?: { assertUrlAllowed(url: string): Promise<void> };
}

const SHOW_ENDPOINT_SUFFIX = '/api/show';
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 4;
const PROBE_MAX_RESPONSE_BYTES = 65_536;
const PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Capability cache, keyed `${connectionId}::${apiModel}`. In-memory only:
 * resets on extension restart — acceptable per contract (capabilities for
 * a fixed model id are near-immutable; the TTL bounds staleness when the
 * upstream ships a new revision under the same id).
 */
const cache = new Map<string, { caps: ProbedCapabilities; expiresAt: number }>();

/**
 * M2 (gate M-package) — per-connection 429 backoff. When a probe batch
 * hits 429, the connection is benched: `probeCapabilities` skips whole
 * batches for that connectionId (empty result + warn) until
 * `notBeforeMs` passes. Without this, every catalog refresh kept
 * re-hammering a rate-limited endpoint batch after batch.
 */
const rateLimitUntil = new Map<string, number>();
const RETRY_AFTER_DEFAULT_MS = 60_000;

/**
 * Parses the `Retry-After` response header (delta-seconds form) into a
 * backoff duration in ms. Anything missing, unparsable or non-positive
 * falls back to the 60 s default (per gate M-package spec).
 */
function parseRetryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return RETRY_AFTER_DEFAULT_MS;
  }
  return seconds * 1000;
}

function benchConnection(ctx: ProbeContext, retryAfterHeader: string | null): void {
  rateLimitUntil.set(ctx.connectionId, Date.now() + parseRetryAfterMs(retryAfterHeader));
}

/** Test/config-change hook — mirrors clearCapabilityCache semantics. */
export function clearCapabilityProbeCache(): void {
  cache.clear();
  // M2 (gate M-package) — also lifts every per-connection 429 bench, so
  // tests (and a config change) start from a clean probing posture.
  rateLimitUntil.clear();
}

function cacheKey(ctx: ProbeContext, apiModel: string): string {
  return `${ctx.connectionId}::${apiModel}`;
}

function readCache(ctx: ProbeContext, apiModel: string): ProbedCapabilities | undefined {
  const entry = cache.get(cacheKey(ctx, apiModel));
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(ctx, apiModel));
    return undefined;
  }
  return entry.caps;
}

function writeCache(ctx: ProbeContext, apiModel: string, caps: ProbedCapabilities): void {
  cache.set(cacheKey(ctx, apiModel), {
    caps,
    expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
  });
}

/**
 * Probes ONE model via `POST /api/show`. Single attempt, bounded timeout,
 * no retry. Never throws for per-model failures — the outcome object
 * classifies the result; only a fatal programming error propagates.
 */
export async function probeModelShow(
  apiModel: string,
  ctx: ProbeContext,
): Promise<ProbeOutcome> {
  const url = `${ctx.rootUrl}${SHOW_ENDPOINT_SUFFIX}`;

  // Security condition — guard BEFORE the request, OUTSIDE the network
  // catch: an SSRF block is terminal and must surface as a throw, not
  // degrade into a quiet capabilities fallback.
  if (ctx.ssrfGuard) {
    await ctx.ssrfGuard.assertUrlAllowed(url);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Security condition: no Authorization for keyless/cloud probes.
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: apiModel }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      // M2 (gate M-package) — bench THIS connection for the next batches
      // (Retry-After seconds, 60 s default), so the next refresh skips
      // the endpoint entirely instead of re-hammering it.
      benchConnection(ctx, res.headers.get('retry-after'));
      return { apiModel, source: 'rate-limited' };
    }
    if (!res.ok) {
      // 401/403 on the public cloud endpoint: never escalate to a keyed
      // retry (contract). 404: model unknown to /api/show — snapshot/
      // heuristic fallback. Other codes: same fallback posture.
      return { apiModel, source: 'unavailable' };
    }

    // M3 (gate M-package) — Content-Length pre-check BEFORE reading the
    // body: a declared-oversized reply is discarded without pulling the
    // payload into memory. The res.text() size cap below stays as
    // defence-in-depth (a lying or absent Content-Length still gets
    // caught after the read). Absent/garbage header → NaN → falls
    // through to the read-path cap.
    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > PROBE_MAX_RESPONSE_BYTES) {
      logger.warn(
        `capability-probe: ${apiModel} declared Content-Length ${declaredLength} exceeds ${PROBE_MAX_RESPONSE_BYTES} bytes — discarded without reading body`,
      );
      return { apiModel, source: 'invalid' };
    }

    const text = await res.text();
    if (text.length > PROBE_MAX_RESPONSE_BYTES) {
      logger.warn(
        `capability-probe: ${apiModel} response exceeded ${PROBE_MAX_RESPONSE_BYTES} bytes — discarded`,
      );
      return { apiModel, source: 'invalid' };
    }

    let parsed: { capabilities?: unknown };
    try {
      parsed = JSON.parse(text) as { capabilities?: unknown };
    } catch {
      return { apiModel, source: 'invalid' };
    }
    if (!Array.isArray(parsed.capabilities)) {
      // Older self-hosted servers (< v0.6.4) omit the field entirely.
      return { apiModel, source: 'invalid' };
    }
    const values = new Set(
      parsed.capabilities.filter((c): c is string => typeof c === 'string'),
    );
    const caps: ProbedCapabilities = {
      imageInput: values.has('vision'),
      reasoning: values.has('thinking'),
      toolCalling: values.has('tools'),
    };
    return { apiModel, capabilities: caps, source: 'api-show' };
  } catch (error) {
    // Network error / timeout / abort — single attempt, degrade quietly.
    logger.debug(
      `capability-probe: ${apiModel} failed (${(error as Error)?.constructor?.name ?? 'unknown'}) — fallback`,
    );
    return { apiModel, source: 'unavailable' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Probes a batch of unknown models: cache-first, concurrency ≤ 4, and a
 * hard batch-cancel on the first 429 (Security condition — a rate-limited
 * catalog refresh must not hammer the endpoint with the rest of the
 * batch; already-collected results are kept). M2 (gate M-package): the
 * 429 also benches the connection (Retry-After, 60 s default) — batches
 * arriving while benched are skipped entirely (empty result + warn).
 *
 * Returns the map of successfully probed capabilities only (failures are
 * absent — the caller falls back to snapshot/heuristics for those ids).
 */
export async function probeCapabilities(
  apiModels: readonly string[],
  ctx: ProbeContext,
): Promise<Map<string, ProbedCapabilities>> {
  const result = new Map<string, ProbedCapabilities>();
  if (apiModels.length === 0) {
    return result;
  }

  // M2 (gate M-package) — 429 backoff: while the connection is benched,
  // skip the whole batch (empty result — the caller falls back to
  // snapshot/heuristics) instead of re-hammering the endpoint.
  const notBefore = rateLimitUntil.get(ctx.connectionId);
  if (notBefore !== undefined) {
    if (Date.now() < notBefore) {
      logger.warn(
        `capability-probe: connection '${ctx.connectionId}' rate-limited until ${new Date(notBefore).toISOString()} — batch skipped (${apiModels.length} models), falling back to snapshot/heuristics`,
      );
      return result;
    }
    rateLimitUntil.delete(ctx.connectionId);
  }

  // Cache pass first — warm refreshes typically re-probe nothing.
  const pending: string[] = [];
  for (const id of apiModels) {
    const cached = readCache(ctx, id);
    if (cached) {
      result.set(id, cached);
    } else {
      pending.push(id);
    }
  }
  if (pending.length === 0) {
    return result;
  }

  let rateLimited = false;
  let index = 0;
  const worker = async (): Promise<void> => {
    while (!rateLimited) {
      const i = index++;
      if (i >= pending.length) {
        return;
      }
      const id = pending[i];
      const outcome = await probeModelShow(id, ctx);
      if (outcome.source === 'rate-limited') {
        rateLimited = true;
        logger.warn(
          `capability-probe: 429 on '${id}' — cancelling batch (${pending.length - i - 1} models skipped, falling back to snapshot/heuristics)`,
        );
        return;
      }
      if (outcome.capabilities) {
        result.set(id, outcome.capabilities);
        writeCache(ctx, id, outcome.capabilities);
      }
    }
  };
  // Single-flight within the process: the worker pool below IS the batch;
  // overlapping refresh calls each build their own (cache-hit) fast path.
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, pending.length) }, () => worker()),
  );
  return result;
}
