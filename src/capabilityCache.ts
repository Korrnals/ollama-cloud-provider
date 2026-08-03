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
  logger.info('Capability cache: cleared all entries');
}