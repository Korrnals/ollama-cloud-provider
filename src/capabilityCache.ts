// Per-connection capability cache for /v1/responses availability.
//
// ADR 0006 — once a connection returns HTTP 404 from /v1/responses,
// memoize "responses unavailable" for that connection's session
// lifetime. Subsequent requests route directly to /chat/completions
// without re-probing, avoiding the per-request 404 round-trip cost.
//
// The cache is process-in-memory only: it resets on VS Code restart
// and on the existing onDidChangeConfiguration handler (call
// `clearCapabilityCache` from there). It is NOT persisted to disk or
// to SecretStorage — capability is observed state, not user config.
import { logger } from './logger.js';

interface CapabilityEntry {
  responsesAvailable: boolean;
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
 * Memoize that the connection does NOT support /v1/responses (a 404
 * was observed). Subsequent `isResponsesKnownUnavailable` checks for
 * this connection return true for the rest of the session.
 */
export function markResponsesUnavailable(connectionId: string): void {
  cache.set(connectionId, {
    responsesAvailable: false,
    checkedAt: Date.now(),
  });
  logger.info(
    `Capability cache: /v1/responses marked unavailable for connection "${connectionId}"`,
  );
}

/**
 * Memoize that the connection DOES support /v1/responses (a request
 * succeeded). Subsequent `isResponsesKnownAvailable` checks for this
 * connection return true for the rest of the session.
 */
export function markResponsesAvailable(connectionId: string): void {
  cache.set(connectionId, {
    responsesAvailable: true,
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