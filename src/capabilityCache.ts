// Per-connection capability cache for /v1/responses and /chat/completions.
//
// ADR 0006 — once a connection returns HTTP 404 from an endpoint,
// memoize "endpoint unavailable" for that connection's session
// lifetime. Subsequent requests route directly to the other endpoint
// without re-probing, avoiding the per-request 404 round-trip cost.
//
// The cache is process-in-memory only: it resets on VS Code restart
// and on the existing onDidChangeConfiguration handler (call
// `clearCapabilityCache` from there). It is NOT persisted to disk or
// to SecretStorage — capability is observed state, not user config.
import { logger } from './logger.js';

interface CapabilityEntry {
  responsesAvailable: boolean;
  chatAvailable: boolean;
  /**
   * Phase 1 (2026-08-03 endpoint routing) — native `/api/chat`
   * capability. Tracked separately from the OpenAI-compat
   * `/chat/completions` `chatAvailable` field because the two are
   * distinct endpoints on the server (different path, different
   * wire format); a 404 on one does not imply a 404 on the other.
   */
  nativeChatAvailable: boolean;
  checkedAt: number;
}

const cache = new Map<string, CapabilityEntry>();

/**
 * Returns true when the connection is KNOWN to NOT support
 * /v1/responses (a prior 404 was memoized). Returns false when the
 * capability has not been probed yet OR when a prior probe succeeded.
 *
 * The caller uses this to short-circuit the /v1/responses attempt and
 * route directly to /chat/completions, avoiding the 404 round-trip.
 */
export function isResponsesKnownUnavailable(connectionId: string): boolean {
  const entry = cache.get(connectionId);
  return entry?.responsesAvailable === false;
}

/**
 * Returns true when the connection is KNOWN to support /v1/responses
 * (a prior request succeeded). Returns false otherwise. Used by
 * `provider.ts` to decide whether to attempt /v1/responses without
 * a probe when `preferredEndpoint === 'auto'`.
 */
export function isResponsesKnownAvailable(connectionId: string): boolean {
  const entry = cache.get(connectionId);
  return entry?.responsesAvailable === true;
}

/**
 * Returns true when the connection is KNOWN to NOT support
 * /chat/completions (a prior 404 was memoized). Used by the
 * symmetric fallback: when the user selects `chat` as primary and
 * the server returns 404, the extension falls back to /v1/responses.
 */
export function isChatKnownUnavailable(connectionId: string): boolean {
  const entry = cache.get(connectionId);
  return entry?.chatAvailable === false;
}

/**
 * Memoize that the connection does NOT support /v1/responses (a 404
 * was observed). Subsequent `isResponsesKnownUnavailable` checks for
 * this connection return true for the rest of the session.
 */
export function markResponsesUnavailable(connectionId: string): void {
  const existing = cache.get(connectionId);
  cache.set(connectionId, {
    responsesAvailable: false,
    chatAvailable: existing?.chatAvailable ?? true,
    nativeChatAvailable: existing?.nativeChatAvailable ?? true,
    checkedAt: Date.now(),
  });
  logger.info(
    `Capability cache: /v1/responses marked unavailable for connection "${connectionId}"`,
  );
}

/**
 * Memoize that the connection DOES support /v1/responses (a request
 * succeeded). Subsequent `isResponsesKnownAvailable` checks for
 * this connection return true for the rest of the session.
 */
export function markResponsesAvailable(connectionId: string): void {
  const existing = cache.get(connectionId);
  cache.set(connectionId, {
    responsesAvailable: true,
    chatAvailable: existing?.chatAvailable ?? true,
    nativeChatAvailable: existing?.nativeChatAvailable ?? true,
    checkedAt: Date.now(),
  });
}

/**
 * Phase 1 (2026-08-03 endpoint routing) — Returns true when the
 * connection is KNOWN to NOT support the native `/api/chat` endpoint
 * (a prior 404 was memoized). Used by `provider.ts` to short-circuit
 * the native path and to fire the explicit-mode error when the
 * user chose `preferredEndpoint: 'native'` explicitly.
 */
export function isNativeChatKnownUnavailable(connectionId: string): boolean {
  const entry = cache.get(connectionId);
  return entry?.nativeChatAvailable === false;
}

/**
 * Phase 1 — Memoize that the connection DOES support the native
 * `/api/chat` endpoint (a request succeeded). Subsequent
 * `isNativeChatKnownUnavailable` checks for this connection return
 * false for the rest of the session.
 */
export function markNativeChatAvailable(connectionId: string): void {
  const existing = cache.get(connectionId);
  cache.set(connectionId, {
    responsesAvailable: existing?.responsesAvailable ?? true,
    chatAvailable: existing?.chatAvailable ?? true,
    nativeChatAvailable: true,
    checkedAt: Date.now(),
  });
}

/**
 * Phase 1 — Memoize that the connection does NOT support the native
 * `/api/chat` endpoint (a 404 was observed). Subsequent
 * `isNativeChatKnownUnavailable` checks for this connection return
 * true for the rest of the session.
 */
export function markNativeChatUnavailable(connectionId: string): void {
  const existing = cache.get(connectionId);
  cache.set(connectionId, {
    responsesAvailable: existing?.responsesAvailable ?? true,
    chatAvailable: existing?.chatAvailable ?? true,
    nativeChatAvailable: false,
    checkedAt: Date.now(),
  });
  logger.info(
    `Capability cache: /api/chat (native) marked unavailable for connection "${connectionId}"`,
  );
}

/**
 * Memoize that the connection does NOT support /chat/completions (a
 * 404 was observed). Subsequent `isChatKnownUnavailable` checks for
 * this connection return true for the rest of the session.
 */
export function markChatUnavailable(connectionId: string): void {
  const existing = cache.get(connectionId);
  cache.set(connectionId, {
    responsesAvailable: existing?.responsesAvailable ?? true,
    chatAvailable: false,
    nativeChatAvailable: existing?.nativeChatAvailable ?? true,
    checkedAt: Date.now(),
  });
  logger.info(
    `Capability cache: /chat/completions marked unavailable for connection "${connectionId}"`,
  );
}

/**
 * Memoize that the connection DOES support /chat/completions (a
 * request succeeded).
 */
export function markChatAvailable(connectionId: string): void {
  const existing = cache.get(connectionId);
  cache.set(connectionId, {
    responsesAvailable: existing?.responsesAvailable ?? true,
    chatAvailable: true,
    nativeChatAvailable: existing?.nativeChatAvailable ?? true,
    checkedAt: Date.now(),
  });
}

/**
 * Clears the entire capability cache. Called from the
 * `onDidChangeConfiguration` handler so a config change (e.g. the
 * user pointing a connection at a new baseUrl) re-probes capability
 * rather than trusting a stale memo.
 */
export function clearCapabilityCache(): void {
  cache.clear();
  endpoint404Cache.clear();
  logger.info('Capability cache: cleared all entries');
}

// ─────────────────────────────────────────────────────────────────────
// v0.9.0 — Auto-recovery tracking (Fix 3).
//
// When `preferredEndpoint === 'auto'`, the provider routes based on
// capability cache memo. But once a 404 is memoized, the connection
// is STUCK on the fallback endpoint for the rest of the session —
// even if the primary endpoint recovers. This module adds a 404
// counter + sliding window so the provider can:
//
//   1. Switch to fallback after 3 consecutive 404s in 5 min
//      (shouldAutoSwitch).
//   2. Reset the counter on any success (reset404s).
//   3. Return to the primary endpoint after 5 min of silence
//      (shouldRetryAfterSilence), enabling auto-recovery.
//
// Keyed by `<connectionId>:<endpointType>` so native/chat/responses
// are tracked independently.
// ─────────────────────────────────────────────────────────────────────

interface Endpoint404Entry {
  consecutive404s: number;
  last404At: number;
}

const endpoint404Cache = new Map<string, Endpoint404Entry>();

const AUTO_SWITCH_THRESHOLD = 3;
const AUTO_SWITCH_WINDOW_MS = 300_000; // 5 min
const RETURN_TO_NATIVE_SILENCE_MS = 300_000; // 5 min

function endpoint404Key(
  connectionId: string,
  endpointType: 'native' | 'chat' | 'responses',
): string {
  return `${connectionId}:${endpointType}`;
}

/**
 * Increment the 404 counter for a connection+endpoint. Called when an
 * endpoint returns HTTP 404 in auto mode. The counter only increments
 * within the sliding window; a 404 outside the window resets the count.
 */
export function mark404(
  connectionId: string,
  endpointType: 'native' | 'chat' | 'responses',
): void {
  const key = endpoint404Key(connectionId, endpointType);
  const existing = endpoint404Cache.get(key);
  const now = Date.now();
  const inWindow =
    existing !== undefined &&
    existing.last404At > 0 &&
    now - existing.last404At < AUTO_SWITCH_WINDOW_MS;
  const consecutive = inWindow ? (existing!.consecutive404s + 1) : 1;
  endpoint404Cache.set(key, { consecutive404s: consecutive, last404At: now });
  logger.info(
    `Capability cache: 404 #${consecutive} for connection "${connectionId}" endpoint "${endpointType}"`,
  );
}

/**
 * Reset the 404 counter for a connection+endpoint. Called on any
 * successful response from that endpoint.
 */
export function reset404s(
  connectionId: string,
  endpointType: 'native' | 'chat' | 'responses',
): void {
  const key = endpoint404Key(connectionId, endpointType);
  const existing = endpoint404Cache.get(key);
  if (existing !== undefined && existing.consecutive404s > 0) {
    endpoint404Cache.set(key, {
      consecutive404s: 0,
      last404At: existing.last404At,
    });
    logger.info(
      `Capability cache: 404 counter reset for connection "${connectionId}" endpoint "${endpointType}"`,
    );
  }
}

/**
 * Returns true when a connection+endpoint has hit 3+ consecutive 404s
 * within the 5-min sliding window — the signal to switch to the
 * fallback endpoint in auto mode.
 */
export function shouldAutoSwitch(
  connectionId: string,
  endpointType: 'native' | 'chat' | 'responses',
): boolean {
  const entry = endpoint404Cache.get(endpoint404Key(connectionId, endpointType));
  if (entry === undefined) {
    return false;
  }
  return (
    entry.consecutive404s >= AUTO_SWITCH_THRESHOLD &&
    Date.now() - entry.last404At < AUTO_SWITCH_WINDOW_MS
  );
}

/**
 * Returns true when a connection has had NO 404 activity for more
 * than 5 min across ANY of its tracked endpoint types (native / chat /
 * responses) — the signal to retry the primary endpoint, enabling
 * auto-recovery from a transient outage.
 *
 * Despite the v0.9.0 auto-recovery block only acting on the native
 * endpoint, this check scans ALL endpoint types for the connection
 * (the caller gates on `isNativeChatKnownUnavailable` first, so only
 * native-silence actually triggers a retry in practice). The
 * cross-endpoint scan keeps the primitive reusable if a future caller
 * needs silence-based retry for chat/responses too.
 */
export function shouldRetryAfterSilence(connectionId: string): boolean {
  const now = Date.now();
  for (const [key, entry] of endpoint404Cache) {
    if (!key.startsWith(`${connectionId}:`)) {
      continue;
    }
    if (entry.last404At > 0 && now - entry.last404At > RETURN_TO_NATIVE_SILENCE_MS) {
      return true;
    }
  }
  return false;
}

/**
 * Sweep the 404 cache for stale entries whose `last404At` is older
 * than `maxAgeMs`. Entries for deleted connections (or connections
 * whose last 404 predates the cutoff) are removed so the cache does
 * not accumulate orphans for process lifetime. Default cutoff is
 * 10 min — 2× the 5-min return-to-native silence window — so a live
 * connection's recent 404 history is never swept prematurely.
 *
 * Called from `clearCapabilityCache` (full reset) and exported so the
 * provider can invoke it periodically (e.g. on config change) for a
 * non-destructive prune.
 */
export function sweepStaleEntries(maxAgeMs: number = 600_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let swept = 0;
  for (const [key, entry] of endpoint404Cache) {
    if (entry.last404At > 0 && entry.last404At < cutoff) {
      endpoint404Cache.delete(key);
      swept++;
    }
  }
  if (swept > 0) {
    logger.info(
      `Capability cache: swept ${swept} stale 404 entr${swept === 1 ? 'y' : 'ies'} (older than ${maxAgeMs}ms)`,
    );
  }
  return swept;
}
