import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  assertBaseUrlAllowed,
  getAllowedBaseUrls,
  getEffectiveBaseUrl,
} from '../../src/configValidator.js';

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