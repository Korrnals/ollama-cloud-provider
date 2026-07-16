import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import { assertBaseUrlAllowed, getEffectiveBaseUrl } from './configValidator.js';
import { logger } from './logger.js';

/**
 * Issue 15 — Check Connection command.
 *
 * Lets the user verify the extension can reach Ollama Cloud without
 * starting a chat. Performs a fast `/v1/models` fetch with a short
 * 10-second timeout (NOT the full `requestTimeoutMs` — a health check
 * should be fast) and reports the result.
 */

export interface HealthCheckResult {
  ok: boolean;
  message: string;
  details?: {
    modelsFound?: number;
    baseUrl?: string;
    latencyMs?: number;
  };
}

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const MODELS_ENDPOINT = '/models';

/**
 * Runs a health check against Ollama Cloud.
 *
 * Steps:
 *   1. Verify baseUrl is in the whitelist (`assertBaseUrlAllowed`).
 *   2. Verify API key is set (SecretStorage + fallbacks).
 *   3. Fetch `/v1/models` with a 10s timeout.
 *   4. Return a structured result with latency + model count.
 *
 * The caller (command handler) is responsible for showing the result
 * to the user via notifications. This function only logs + returns.
 */
export async function performHealthCheck(
  authManager: AuthManager,
): Promise<HealthCheckResult> {
  const baseUrl = getEffectiveBaseUrl();

  // Step 1 — whitelist gate.
  try {
    assertBaseUrlAllowed(baseUrl);
  } catch {
    const result: HealthCheckResult = {
      ok: false,
      message: 'baseUrl not whitelisted',
    };
    logger.warn(`Health check: ${result.message}`, { baseUrl });
    return result;
  }

  // Step 2 — API key gate.
  const apiKey = await authManager.getApiKey();
  if (!apiKey) {
    const result: HealthCheckResult = {
      ok: false,
      message: 'API key not set',
    };
    logger.warn(`Health check: ${result.message}`);
    return result;
  }

  // Step 3 — reachability fetch with short timeout.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    HEALTH_CHECK_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}${MODELS_ENDPOINT}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      const result: HealthCheckResult = {
        ok: false,
        message: `HTTP ${response.status}`,
      };
      logger.warn(`Health check failed: ${result.message}`);
      return result;
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const modelsFound = payload.data?.length ?? 0;
    const latencyMs = Date.now() - startedAt;

    const result: HealthCheckResult = {
      ok: true,
      message: 'Connection OK',
      details: { modelsFound, baseUrl, latencyMs },
    };
    logger.info(`Health check passed: ${result.message}`, result.details);
    return result;
  } catch (error) {
    const isTimeout =
      error instanceof Error && error.name === 'AbortError';
    const message = isTimeout
      ? `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    const result: HealthCheckResult = { ok: false, message };
    logger.warn(`Health check failed: ${message}`, error);
    return result;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Runs a health check and shows the result to the user via the
 * appropriate notification (info message on success, error on failure).
 * Intended as the command handler body for `ollamaCloud.checkConnection`.
 */
export async function runHealthCheckCommand(
  authManager: AuthManager,
): Promise<HealthCheckResult> {
  const result = await performHealthCheck(authManager);

  if (result.ok) {
    const detail = result.details;
    const modelsPart =
      detail && detail.modelsFound !== undefined
        ? ` ${detail.modelsFound} models found.`
        : '';
    const latencyPart =
      detail && detail.latencyMs !== undefined ? ` (${detail.latencyMs}ms)` : '';
    void vscode.window.showInformationMessage(
      `Ollama Cloud: ${result.message}.${modelsPart}${latencyPart}`,
    );
  } else {
    void vscode.window.showErrorMessage(
      `Ollama Cloud: ${result.message}`,
    );
  }

  return result;
}