import * as vscode from 'vscode';

/**
 * Issue 9 — baseUrl whitelist enforcement.
 *
 * Upstream sent the API key to whatever `baseUrl` the user configured.
 * A malicious workspace `.vscode/settings.json` could redirect the key
 * to an attacker-controlled host. This module is the single source of
 * truth for the whitelist check.
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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}