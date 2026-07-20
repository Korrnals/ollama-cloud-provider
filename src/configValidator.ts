import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import type { ConnectionConfig } from './connections.js';
import { logger } from './logger.js';

/**
 * Issue 9 — baseUrl whitelist enforcement.
 *
 * Without a whitelist, the API key would be sent to whatever `baseUrl`
 * the user configured. A malicious workspace `.vscode/settings.json`
 * could redirect the key to an attacker-controlled host. This module
 * is the single source of truth for the whitelist check.
 *
 * Defense in depth: every HTTP-emitting module (OllamaClient,
 * ModelCatalog) MUST call `assertBaseUrlAllowed` before `fetch`. The
 * check is NOT performed only at activation — it runs at every request
 * boundary, so a config change mid-session can never bypass it.
 *
 * The check refuses the request outright. It does NOT silently fall
 * back to the default URL — a silent fallback would mask a misconfigured
 * or malicious workspace and still leak the failure mode.
 */

const DEFAULT_ALLOWED_BASE_URLS: readonly string[] = ['https://ollama.com/v1'];
const REQUEST_TIMEOUT_MIN_MS = 5000;
const REQUEST_TIMEOUT_MAX_MS = 600000;
const MAX_RETRIES_MAX = 10;
// MEDIUM-2 — reachability probe uses a short 10s timeout (mirrors
// healthCheck.ts) NOT the full REQUEST_TIMEOUT_MAX_MS (10 min). A
// validation probe should fail fast, not hang for 10 minutes on an
// unreachable host.
const VALIDATE_REACHABILITY_TIMEOUT_MS = 10000;

/**
 * Issue 16 — `Validate Configuration` command result.
 *
 * Each entry is one named check with a pass/fail flag and a human-
 * readable message. The {@link ok} flag is true only when every check
 * passed.
 */
export interface ValidationResult {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; message: string }>;
}

/**
 * Issue 16 — runs the full validation suite and reports the result.
 *
 * Checks:
 *   1. baseUrl whitelisted
 *   2. API key set (SecretStorage or fallback config/env)
 *   3. baseUrl reachable (fetch /v1/models — reuses the health check
 *      logic by reading `ollamaCloud.requestTimeoutMs` to bound the
 *      reachability probe; a fast probe is preferred but the full
 *      timeout is the upper bound)
 *   4. requestTimeoutMs valid (between 5000 and 600000)
 *   5. maxRetries valid (>= 0 when the key exists)
 *
 * The reachability check requires an API key — if the key is missing,
 * the reachability check is marked as skipped (not failed) because a
 * 401 would not indicate an unreachable host. The {@link ok} flag
 * requires all *performed* checks to pass; skipped checks do not fail
 * the suite.
 *
 * Results are written to the hardened logger's output channel (one line
 * per check) and a summary notification is shown. The function is safe
 * to call from the command handler.
 */
export async function validateConfiguration(
  authManager: AuthManager,
): Promise<ValidationResult> {
  const checks: ValidationResult['checks'] = [];

  // Check 1 — baseUrl whitelisted.
  const baseUrl = getEffectiveBaseUrl();
  const allowed = getAllowedBaseUrls();
  const baseUrlOk = allowed.includes(baseUrl);
  checks.push({
    name: 'baseUrl whitelisted',
    passed: baseUrlOk,
    message: baseUrlOk
      ? `baseUrl '${baseUrl}' is whitelisted`
      : `baseUrl '${baseUrl}' is NOT in allowedBaseUrls`,
  });

  // Check 2 — API key set.
  const apiKey = await authManager.getApiKey();
  const apiKeyOk = typeof apiKey === 'string' && apiKey.length > 0;
  checks.push({
    name: 'API key set',
    passed: apiKeyOk,
    message: apiKeyOk ? 'API key is configured' : 'API key is missing',
  });

  // Check 3 — baseUrl reachable. Skipped (not failed) when no API key
  // OR when baseUrl is not whitelisted: HIGH-1 — a non-whitelisted
  // baseUrl must NEVER receive the API key, even during a validation
  // probe. The reachability fetch sends `Authorization: Bearer`, so
  // gating it on `apiKeyOk && baseUrlOk` closes the SEC-03 bypass that
  // Issue 9 was meant to prevent. A malicious workspace cannot
  // exfiltrate the key via the `Validate Configuration` command.
  let reachableOk = false;
  let reachableMessage =
    !apiKeyOk
      ? 'skipped (no API key)'
      : 'skipped (baseUrl not whitelisted)';
  if (apiKeyOk && baseUrlOk) {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        VALIDATE_REACHABILITY_TIMEOUT_MS,
      );
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        reachableOk = response.ok;
        reachableMessage = reachableOk
          ? 'baseUrl reachable'
          : `baseUrl returned HTTP ${response.status}`;
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch (error) {
      reachableMessage =
        error instanceof Error ? error.message : String(error);
    }
  }
  checks.push({
    name: 'baseUrl reachable',
    passed: apiKeyOk ? reachableOk : true,
    message: reachableMessage,
  });

  // Check 4 — requestTimeoutMs valid.
  const timeoutMs = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<number>('requestTimeoutMs');
  const timeoutValid =
    typeof timeoutMs === 'number' &&
    timeoutMs >= REQUEST_TIMEOUT_MIN_MS &&
    timeoutMs <= REQUEST_TIMEOUT_MAX_MS;
  checks.push({
    name: 'requestTimeoutMs valid',
    passed: timeoutValid,
    message: timeoutValid
      ? `requestTimeoutMs=${timeoutMs}`
      : `requestTimeoutMs=${timeoutMs} is outside [${REQUEST_TIMEOUT_MIN_MS}, ${REQUEST_TIMEOUT_MAX_MS}]`,
  });

  // Check 5 — maxRetries valid (only if the key is declared).
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const maxRetries = config.get<number>('maxRetries');
  const retriesValid =
    typeof maxRetries === 'number' && maxRetries >= 0 && maxRetries <= MAX_RETRIES_MAX;
  checks.push({
    name: 'maxRetries valid',
    passed: retriesValid,
    message: retriesValid
      ? `maxRetries=${maxRetries}`
      : `maxRetries=${maxRetries} is invalid (expected 0..${MAX_RETRIES_MAX})`,
  });

  // Emit one line per check to the output channel, then a summary line.
  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    logger.info(`[validateConfig] ${status} ${check.name}: ${check.message}`);
  }
  const failed = checks.filter((c) => !c.passed);
  const ok = failed.length === 0;
  logger.info(
    `[validateConfig] summary: ${ok ? 'valid' : `${failed.length} issue(s)`}`,
  );
  logger.show();

  if (ok) {
    void vscode.window.showInformationMessage('Ollama Cloud: Configuration valid.');
  } else {
    void vscode.window.showWarningMessage(
      `Ollama Cloud: Configuration has ${failed.length} issue(s). See logs for details.`,
    );
  }

  return { ok, checks };
}

/**
 * Returns the normalized baseUrl the extension will actually use for
 * requests. Reads `ollamaCloud.baseUrl` from VS Code configuration.
 */
export function getEffectiveBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<string>('baseUrl');
  return normalizeBaseUrl(configured || getDefaultBaseUrl());
}

/**
 * Returns the default baseUrl (first entry of allowedBaseUrls, or the
 * hardcoded fallback if the whitelist is empty / misconfigured).
 */
export function getDefaultBaseUrl(): string {
  const allowed = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<string[]>('allowedBaseUrls');
  return normalizeBaseUrl(
    allowed && allowed.length > 0 ? allowed[0] : DEFAULT_ALLOWED_BASE_URLS[0],
  );
}

/**
 * Returns the current allowedBaseUrls whitelist from VS Code configuration.
 */
export function getAllowedBaseUrls(): string[] {
  const allowed = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<string[]>('allowedBaseUrls');
  if (!allowed || allowed.length === 0) {
    return [...DEFAULT_ALLOWED_BASE_URLS];
  }
  return allowed.map(normalizeBaseUrl);
}

/**
 * Asserts that `baseUrl` is in the `ollamaCloud.allowedBaseUrls` whitelist.
 * Throws an Error if it is not — never silently falls back.
 *
 * Call this at every HTTP request boundary, immediately before `fetch`.
 * Config is re-read on every call so a `onDidChangeConfiguration` listener
 * is not required for correctness (but callers may add one to invalidate
 * caches). The read is cheap — VS Code config is in-process.
 *
 * @throws Error when baseUrl is not whitelisted.
 */
export function assertBaseUrlAllowed(baseUrl: string): void {
  const normalized = normalizeBaseUrl(baseUrl);
  const allowed = getAllowedBaseUrls();

  if (!allowed.includes(normalized)) {
    throw new Error(
      `Ollama Cloud: baseUrl '${normalized}' is not in allowedBaseUrls whitelist. Add it to ollamaCloud.allowedBaseUrls or use the default.`,
    );
  }
}

/**
 * Multi-connection variant — asserts that `baseUrl` is in the
 * connection's OWN `allowedBaseUrls` whitelist. This is the SEC-03
 * enforcement at per-connection fetch boundaries. Fail-closed: a
 * non-whitelisted host throws and the API key is never sent.
 *
 * Use this in preference to `assertBaseUrlAllowed` when the caller
 * already resolved a `ConnectionConfig`. The two functions compose:
 * `assertBaseUrlAllowed` covers the legacy single-connection path,
 * `assertBaseUrlAllowedForConnection` covers the multi-connection path.
 *
 * @throws Error when baseUrl is not in the connection's whitelist.
 */
export function assertBaseUrlAllowedForConnection(
  baseUrl: string,
  connection: ConnectionConfig,
): void {
  const normalized = normalizeBaseUrl(baseUrl);
  const allowed = connection.allowedBaseUrls.map(normalizeBaseUrl);

  if (!allowed.includes(normalized)) {
    throw new Error(
      `Ollama Cloud: baseUrl '${normalized}' is not in the allowedBaseUrls whitelist for connection '${connection.id}'. Add it to the connection's allowedBaseUrls or use the connection's default baseUrl.`,
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}