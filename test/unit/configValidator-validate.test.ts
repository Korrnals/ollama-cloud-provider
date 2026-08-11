import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { validateConfiguration } from '../../src/configValidator.js';
import { AuthManager } from '../../src/auth.js';

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Builds a minimal mock ExtensionContext manually. `vscode`'s types-only
 * package does NOT expose a `createExtensionContext` API, so the test
 * stub's runtime helper cannot be used under tsc. This builder mirrors
 * only the surface `AuthManager` exercises (secrets + subscriptions).
 */
function makeMockContext(): vscode.ExtensionContext {
  const secrets = new Map<string, string>();
  const secretListeners = new Set<(e: { key: string }) => void>();
  return {
    subscriptions: [],
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        for (const listener of secretListeners) {
          listener({ key });
        }
        return Promise.resolve();
      },
      onDidChange: (listener: (e: { key: string }) => void) => {
        secretListeners.add(listener);
        return { dispose: () => secretListeners.delete(listener) };
      },
    },
    extensionPath: '/test/extension-path',
    extensionUri: {
      toString: () => 'file:///test/extension-path',
      fsPath: '/test/extension-path',
    },
  } as unknown as vscode.ExtensionContext;
}

function makeAuthManager(): AuthManager {
  return new AuthManager(makeMockContext());
}

describe('configValidator.validateConfiguration', () => {
  beforeEach(() => {
    // Fresh, all-valid baseline. requestTimeoutMs / requestInactivityTimeoutMs
    // are NOT set — both settings were removed from package.json (ArchCom 0011c
    // disabled the inactivity timer; the legacy single-timer alias retired
    // with the three-timer ADR 0005 migration). Only the two live timers are
    // configured.
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      requestConnectTimeoutMs: 30000,
      requestMaxDurationMs: 1800000,
      maxRetries: 3,
    });
    delete process.env.OLLAMA_API_KEY;
  });

  it('skips reachability when baseUrl is whitelisted but no API key (no key set fails the suite)', async () => {
    const ctx = makeMockContext();
    const auth = new AuthManager(ctx);
    const result = await validateConfiguration(auth);
    // No API key => "API key set" check fails (it is NOT a skipped check),
    // so the overall result is NOT ok. Reachability IS skipped, though,
    // because the probe never runs without a key to send.
    assert.equal(result.ok, false, `expected ok=false (API key missing), got ${JSON.stringify(result)}`);
    const reachCheck = result.checks.find((c) =>
      c.name === 'baseUrl reachable',
    );
    assert.ok(reachCheck, 'reachable check missing');
    assert.ok(
      reachCheck!.message.startsWith('skipped'),
      `expected skipped, got ${reachCheck!.message}`,
    );
  });

  it('fails when baseUrl is not whitelisted and skips reachability (HIGH-1 gate)', async () => {
    setConfig({
      baseUrl: 'https://evil.example.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      requestConnectTimeoutMs: 30000,
      requestMaxDurationMs: 1800000,
      maxRetries: 3,
    });
    // Also set an API key to prove reachability is STILL skipped
    // when baseUrl is not whitelisted.
    const ctx = makeMockContext();
    await ctx.secrets.store('ollamaCloud.apiKey', 'sk-test-key');
    const auth = new AuthManager(ctx);
    const result = await validateConfiguration(auth);
    assert.equal(result.ok, false);
    const baseCheck = result.checks.find((c) => c.name === 'baseUrl whitelisted');
    assert.equal(baseCheck!.passed, false);
    const reachCheck = result.checks.find((c) => c.name === 'baseUrl reachable');
    assert.ok(
      reachCheck!.message.startsWith('skipped'),
      `reachability must skip when baseUrl not whitelisted, got ${reachCheck!.message}`,
    );
  });

  it('fails when requestConnectTimeoutMs is out of range', async () => {
    // requestTimeoutMs (legacy single-timer alias) is no longer validated —
    // the setting was removed from package.json. The live connect timer is
    // requestConnectTimeoutMs; an out-of-range value must FAIL the check.
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      requestConnectTimeoutMs: 1000, // below 5000 min
      requestMaxDurationMs: 1800000,
      maxRetries: 3,
    });
    const auth = makeAuthManager();
    const result = await validateConfiguration(auth);
    assert.equal(result.ok, false);
    const connectCheck = result.checks.find(
      (c) => c.name === 'requestConnectTimeoutMs valid',
    );
    assert.equal(connectCheck!.passed, false);
  });

  it('fails when maxRetries is negative', async () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      requestConnectTimeoutMs: 30000,
      requestMaxDurationMs: 1800000,
      maxRetries: -1,
    });
    const auth = makeAuthManager();
    const result = await validateConfiguration(auth);
    assert.equal(result.ok, false);
    const retriesCheck = result.checks.find((c) => c.name === 'maxRetries valid');
    assert.equal(retriesCheck!.passed, false);
  });

  it('fails the suite on missing API key but reports reachability as skipped (6 checks emitted)', async () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      maxRetries: 3,
      requestConnectTimeoutMs: 30000,
      requestMaxDurationMs: 1800000,
    });
    const auth = makeAuthManager();
    const result = await validateConfiguration(auth);
    // Missing API key fails the "API key set" check, so the suite
    // is not ok — but all 6 checks are still emitted: baseUrl, API key,
    // reachable, connect timer, max-duration timer, maxRetries. The
    // legacy requestTimeoutMs and the disabled requestInactivityTimeoutMs
    // are NOT validated (both removed from package.json).
    assert.equal(result.ok, false);
    assert.equal(result.checks.length, 6);
    const reachCheck = result.checks.find((c) => c.name === 'baseUrl reachable');
    assert.ok(reachCheck, 'reachable check missing');
    assert.ok(
      reachCheck!.message.startsWith('skipped'),
      `expected skipped, got ${reachCheck!.message}`,
    );
  });
});
