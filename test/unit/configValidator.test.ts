import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  assertBaseUrlAllowed,
  assertBaseUrlAllowedForConnection,
  getAllowedBaseUrls,
  getEffectiveBaseUrl,
} from '../../src/configValidator.js';
import type { ConnectionConfig } from '../../src/connections.js';

describe('configValidator.assertBaseUrlAllowed', () => {
  beforeEach(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
  });

  it('accepts a whitelisted baseUrl', () => {
    assert.doesNotThrow(() =>
      assertBaseUrlAllowed('https://ollama.com/v1'),
    );
  });

  it('throws on a non-whitelisted baseUrl', () => {
    assert.throws(
      () => assertBaseUrlAllowed('https://evil.example.com/v1'),
      /not in allowedBaseUrls/,
    );
  });

  it('falls back to the default list when allowedBaseUrls is empty', () => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: [],
    });
    // Empty allowedBaseUrls → getAllowedBaseUrls returns DEFAULT.
    assert.deepEqual(getAllowedBaseUrls(), ['https://ollama.com/v1']);
    assert.doesNotThrow(() =>
      assertBaseUrlAllowed('https://ollama.com/v1'),
    );
  });

  it('normalizes trailing slashes before comparison', () => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1/'],
    });
    // Trailing slash in the whitelist entry must still match the
    // trailing-slash-stripped input.
    assert.doesNotThrow(() =>
      assertBaseUrlAllowed('https://ollama.com/v1'),
    );
    assert.doesNotThrow(() =>
      assertBaseUrlAllowed('https://ollama.com/v1/'),
    );
  });

  it('rejects subdomain bypass attempts', () => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    // A subdomain is a different host — must not match.
    assert.throws(
      () => assertBaseUrlAllowed('https://evil.ollama.com/v1'),
      /not in allowedBaseUrls/,
    );
  });

  it('rejects similar-host bypass attempts', () => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    // Homograph / look-alike host.
    assert.throws(
      () => assertBaseUrlAllowed('https://ollama-com.evil.example.com/v1'),
      /not in allowedBaseUrls/,
    );
  });

  it('getEffectiveBaseUrl reads the configured baseUrl', () => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    assert.equal(getEffectiveBaseUrl(), 'https://ollama.com/v1');
  });
});

/**
 * Builds a ConnectionConfig with the given whitelist. Only the fields
 * `assertBaseUrlAllowedForConnection` reads (`id`, `allowedBaseUrls`)
 * matter; the rest are neutral defaults.
 */
function makeConnection(
  id: string,
  allowedBaseUrls: readonly string[],
): ConnectionConfig {
  return {
    id,
    label: id,
    type: 'remote',
    enabled: true,
    baseUrl: allowedBaseUrls[0] ?? 'https://example.com/v1',
    openaiCompatiblePath: '',
    allowedBaseUrls,
    visionModels: [],
    requiresApiKey: true,
  };
}

describe('configValidator.assertBaseUrlAllowedForConnection — per-connection whitelist', () => {
  it('accepts a baseUrl in the connection whitelist', () => {
    const conn = makeConnection('vps1', ['https://vps.example.com/v1']);
    assert.doesNotThrow(() =>
      assertBaseUrlAllowedForConnection('https://vps.example.com/v1', conn),
    );
  });

  it('throws when the baseUrl is not in the connection whitelist', () => {
    const conn = makeConnection('vps1', ['https://vps.example.com/v1']);
    assert.throws(
      () =>
        assertBaseUrlAllowedForConnection('https://evil.example.com/v1', conn),
      /not in the allowedBaseUrls whitelist for connection 'vps1'/,
    );
  });

  it('rejects a subdomain bypass attempt per-connection', () => {
    // Whitelist has ollama.com; a request to evil.ollama.com must be
    // rejected — a subdomain is a different host.
    const conn = makeConnection('vps1', ['https://ollama.com/v1']);
    assert.throws(
      () => assertBaseUrlAllowedForConnection('https://evil.ollama.com/v1', conn),
      /not in the allowedBaseUrls whitelist for connection 'vps1'/,
    );
  });

  it('rejects a similar-host bypass attempt per-connection', () => {
    const conn = makeConnection('vps1', ['https://ollama.com/v1']);
    assert.throws(
      () =>
        assertBaseUrlAllowedForConnection('https://ollama-com.evil.example.com/v1', conn),
      /not in the allowedBaseUrls whitelist for connection 'vps1'/,
    );
  });

  it('does NOT fall back to the global whitelist for a non-cloud connection', () => {
    // Global whitelist has evil.example.com; the connection whitelist
    // does not. The connection's own whitelist is the only authority.
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1', 'https://evil.example.com/v1'],
    });
    const conn = makeConnection('vps1', ['https://vps.example.com/v1']);
    assert.throws(
      () =>
        assertBaseUrlAllowedForConnection('https://evil.example.com/v1', conn),
      /not in the allowedBaseUrls whitelist for connection 'vps1'/,
    );
  });

  it('normalizes trailing slashes before comparison', () => {
    const conn = makeConnection('vps1', ['https://vps.example.com/v1/']);
    assert.doesNotThrow(() =>
      assertBaseUrlAllowedForConnection('https://vps.example.com/v1', conn),
    );
    assert.doesNotThrow(() =>
      assertBaseUrlAllowedForConnection('https://vps.example.com/v1/', conn),
    );
  });

  it('throws for an empty whitelist (fail-closed)', () => {
    const conn = makeConnection('vps1', []);
    assert.throws(
      () =>
        assertBaseUrlAllowedForConnection('https://vps.example.com/v1', conn),
      /not in the allowedBaseUrls whitelist for connection 'vps1'/,
    );
  });

  it('accepts any of multiple whitelisted hosts for the connection', () => {
    const conn = makeConnection('vps1', [
      'https://vps.example.com/v1',
      'https://backup.example.com/v1',
    ]);
    assert.doesNotThrow(() =>
      assertBaseUrlAllowedForConnection('https://vps.example.com/v1', conn),
    );
    assert.doesNotThrow(() =>
      assertBaseUrlAllowedForConnection('https://backup.example.com/v1', conn),
    );
  });
});

describe('configValidator — global vs per-connection isolation regression', () => {
  it('global assertBaseUrlAllowed still enforces the legacy whitelist', () => {
    // Regression guard: the legacy single-connection path is unchanged
    // by the multi-connection feature. A non-whitelisted host throws
    // via the global check, tied to the new per-connection path.
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    assert.doesNotThrow(() =>
      assertBaseUrlAllowed('https://ollama.com/v1'),
    );
    assert.throws(
      () => assertBaseUrlAllowed('https://evil.example.com/v1'),
      /not in allowedBaseUrls/,
    );
  });

  it('per-connection whitelist is independent of the global whitelist', () => {
    // The connection declares its own whitelist; the global has a
    // different one. The per-connection check uses only the
    // connection's list — neither inherits from the other.
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    const conn = makeConnection('vps1', ['https://vps.example.com/v1']);

    // Global check: vps.example.com is NOT in the global whitelist.
    assert.throws(
      () => assertBaseUrlAllowed('https://vps.example.com/v1'),
      /not in allowedBaseUrls/,
    );
    // Per-connection check: vps.example.com IS in the connection whitelist.
    assert.doesNotThrow(() =>
      assertBaseUrlAllowedForConnection('https://vps.example.com/v1', conn),
    );
    // Per-connection check: ollama.com is NOT in the connection whitelist.
    assert.throws(
      () =>
        assertBaseUrlAllowedForConnection('https://ollama.com/v1', conn),
      /not in the allowedBaseUrls whitelist for connection 'vps1'/,
    );
  });
});