import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  CLOUD_CONNECTION_ID,
  apiKeySecretKey,
  connectionOriginLabel,
  findConnection,
  loadConnections,
  modelIdPrefix,
  openAiBaseUrl,
  parseModelId,
  type ConnectionConfig,
} from '../../src/connections.js';

/**
 * Multi-connection normalization + helpers tests. Drives
 * `loadConnections()` through the `vscode` stub's workspace config
 * (same pattern as `test/unit/configValidator.test.ts`), so no real
 * VS Code or network is involved.
 *
 * Coverage:
 *   - backward compat: empty `connections` → synthesized cloud connection.
 *   - per-connection `allowedBaseUrls` fail-closed defaults.
 *   - per-connection API key SecretStorage key derivation.
 *   - model id prefix + origin label per connection type.
 *   - `parseModelId` round-trip.
 */

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

/**
 * Returns the cloud connection from `loadConnections()`. Throws if
 * there is not exactly one cloud connection — the normalizer guarantees
 * one exists.
 */
function cloudConnection(): ConnectionConfig {
  const conns = loadConnections();
  const cloud = conns.find((c) => c.id === CLOUD_CONNECTION_ID);
  assert.ok(cloud, 'cloud connection must always be present');
  return cloud;
}

describe('connections.loadConnections — backward compatibility', () => {
  beforeEach(() => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [],
      visionModels: [],
    });
  });

  it('synthesizes the cloud connection when connections is empty', () => {
    const conns = loadConnections();
    assert.equal(conns.length, 1);
    assert.equal(conns[0].id, CLOUD_CONNECTION_ID);
    assert.equal(conns[0].type, 'cloud');
    assert.equal(conns[0].baseUrl, 'https://ollama.com/v1');
  });

  it('synthesizes the cloud connection when connections is absent', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    const conns = loadConnections();
    assert.equal(conns.length, 1);
    assert.equal(conns[0].id, CLOUD_CONNECTION_ID);
  });

  it('uses the legacy baseUrl when connections is empty', () => {
    setConfig({
      baseUrl: 'https://custom.example.com/v1',
      allowedBaseUrls: ['https://custom.example.com/v1'],
      connections: [],
    });
    const cloud = cloudConnection();
    assert.equal(cloud.baseUrl, 'https://custom.example.com/v1');
  });

  it('inherits the global allowedBaseUrls for the cloud connection', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1', 'https://staging.ollama.com/v1'],
      connections: [],
    });
    const cloud = cloudConnection();
    assert.deepEqual(cloud.allowedBaseUrls, [
      'https://ollama.com/v1',
      'https://staging.ollama.com/v1',
    ]);
  });

  it('inherits the global visionModels for the cloud connection', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [],
      visionModels: ['my-vision:*'],
    });
    const cloud = cloudConnection();
    assert.deepEqual(cloud.visionModels, ['my-vision:*']);
  });

  it('falls back to [baseUrl] when global allowedBaseUrls is empty', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: [],
      connections: [],
    });
    const cloud = cloudConnection();
    assert.deepEqual(cloud.allowedBaseUrls, ['https://ollama.com/v1']);
  });
});

describe('connections.loadConnections — declared entries', () => {
  beforeEach(() => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [],
      visionModels: [],
    });
  });

  it('normalizes a local connection with a fail-closed default whitelist', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'home', type: 'local', baseUrl: 'http://localhost:11434' },
      ],
    });
    const conns = loadConnections();
    const home = findConnection(conns, 'home');
    assert.ok(home);
    assert.equal(home.type, 'local');
    assert.equal(home.baseUrl, 'http://localhost:11434');
    // Fail-closed: only the connection's own baseUrl.
    assert.deepEqual(home.allowedBaseUrls, ['http://localhost:11434']);
  });

  it('normalizes a remote connection with a fail-closed default whitelist', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'vps1', type: 'remote', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    const vps = findConnection(conns, 'vps1');
    assert.ok(vps);
    assert.deepEqual(vps.allowedBaseUrls, ['https://vps.example.com/v1']);
  });

  it('respects an explicitly declared allowedBaseUrls on a connection', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        {
          id: 'vps1',
          type: 'remote',
          baseUrl: 'https://vps.example.com/v1',
          allowedBaseUrls: [
            'https://vps.example.com/v1',
            'https://backup.example.com/v1',
          ],
        },
      ],
    });
    const conns = loadConnections();
    const vps = findConnection(conns, 'vps1');
    assert.ok(vps);
    assert.deepEqual(vps.allowedBaseUrls, [
      'https://vps.example.com/v1',
      'https://backup.example.com/v1',
    ]);
  });

  it('does NOT fall back to global allowedBaseUrls for a non-cloud connection', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1', 'https://evil.example.com/v1'],
      connections: [
        { id: 'vps1', type: 'remote', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    const vps = findConnection(conns, 'vps1');
    assert.ok(vps);
    // The global evil.example.com entry MUST NOT leak into the
    // connection's whitelist — fail-closed isolation.
    assert.deepEqual(vps.allowedBaseUrls, ['https://vps.example.com/v1']);
  });

  it('filters out disabled connections', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'home', type: 'local', baseUrl: 'http://localhost:11434', enabled: false },
        { id: 'vps1', type: 'remote', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    assert.ok(findConnection(conns, 'cloud'));
    assert.ok(findConnection(conns, 'vps1'));
    assert.equal(findConnection(conns, 'home'), undefined);
  });

  it('slugifies the connection id (lowercase, restricted charset)', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'My_VPS Server!', type: 'remote', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    // Disallowed chars → '-'; the resulting id is slug-safe.
    assert.ok(findConnection(conns, 'my_vps-server-'));
  });

  it('infers the type from baseUrl when type is omitted (localhost → local)', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'home', baseUrl: 'http://localhost:11434' },
      ],
    });
    const conns = loadConnections();
    const home = findConnection(conns, 'home');
    assert.ok(home);
    assert.equal(home.type, 'local');
  });

  it('infers the type from baseUrl when type is omitted (ollama.com → cloud)', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'cloud', baseUrl: 'https://ollama.com/v1' },
      ],
    });
    const conns = loadConnections();
    const cloud = findConnection(conns, 'cloud');
    assert.ok(cloud);
    assert.equal(cloud.type, 'cloud');
  });

  it('infers remote for an unknown host when type is omitted', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'vps1', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    const vps = findConnection(conns, 'vps1');
    assert.ok(vps);
    assert.equal(vps.type, 'remote');
  });

  it('per-connection visionModels override does not leak to other connections', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        {
          id: 'vps1',
          type: 'remote',
          baseUrl: 'https://vps.example.com/v1',
          visionModels: ['vps-vision:*'],
        },
        {
          id: 'vps2',
          type: 'remote',
          baseUrl: 'https://vps2.example.com/v1',
        },
      ],
    });
    const conns = loadConnections();
    const vps1 = findConnection(conns, 'vps1');
    const vps2 = findConnection(conns, 'vps2');
    assert.ok(vps1);
    assert.ok(vps2);
    assert.deepEqual(vps1.visionModels, ['vps-vision:*']);
    assert.deepEqual(vps2.visionModels, []);
  });

  it('local connection defaults to requiresApiKey=false', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'home', type: 'local', baseUrl: 'http://localhost:11434' },
      ],
    });
    const conns = loadConnections();
    const home = findConnection(conns, 'home');
    assert.ok(home);
    assert.equal(home.requiresApiKey, false);
  });

  it('remote connection defaults to requiresApiKey=true', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        { id: 'vps1', type: 'remote', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    const vps = findConnection(conns, 'vps1');
    assert.ok(vps);
    assert.equal(vps.requiresApiKey, true);
  });

  it('respects an explicit requiresApiKey override', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        {
          id: 'home',
          type: 'local',
          baseUrl: 'http://localhost:11434',
          requiresApiKey: true,
        },
      ],
    });
    const conns = loadConnections();
    const home = findConnection(conns, 'home');
    assert.ok(home);
    assert.equal(home.requiresApiKey, true);
  });

  it('strips trailing slashes from baseUrl and allowedBaseUrls', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        {
          id: 'vps1',
          type: 'remote',
          baseUrl: 'https://vps.example.com/v1/',
          allowedBaseUrls: ['https://vps.example.com/v1/'],
        },
      ],
    });
    const conns = loadConnections();
    const vps = findConnection(conns, 'vps1');
    assert.ok(vps);
    assert.equal(vps.baseUrl, 'https://vps.example.com/v1');
    assert.deepEqual(vps.allowedBaseUrls, ['https://vps.example.com/v1']);
  });

  it('uses the label when provided, else derives from type', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        {
          id: 'home',
          type: 'local',
          baseUrl: 'http://localhost:11434',
          label: 'Home Server',
        },
        {
          id: 'vps1',
          type: 'remote',
          baseUrl: 'https://vps.example.com/v1',
        },
      ],
    });
    const conns = loadConnections();
    const home = findConnection(conns, 'home');
    const vps = findConnection(conns, 'vps1');
    assert.ok(home);
    assert.ok(vps);
    assert.equal(home.label, 'Home Server');
    assert.equal(vps.label, 'VPS');
  });

  it('skips invalid entries (non-object, missing id)', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        'not-an-object',
        { id: '', baseUrl: 'https://x.example.com/v1' },
        { id: 'valid', type: 'remote', baseUrl: 'https://vps.example.com/v1' },
      ],
    });
    const conns = loadConnections();
    assert.ok(findConnection(conns, 'cloud'));
    assert.ok(findConnection(conns, 'valid'));
    // The two invalid entries were skipped (not present as connections).
    assert.equal(conns.length, 2);
  });

  it('a declared cloud entry overrides the synthesized cloud connection', () => {
    setConfig({
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
      connections: [
        {
          id: 'cloud',
          type: 'cloud',
          baseUrl: 'https://staging.ollama.com/v1',
          allowedBaseUrls: ['https://staging.ollama.com/v1'],
        },
      ],
    });
    const cloud = cloudConnection();
    assert.equal(cloud.baseUrl, 'https://staging.ollama.com/v1');
    assert.deepEqual(cloud.allowedBaseUrls, ['https://staging.ollama.com/v1']);
  });
});

describe('connections.apiKeySecretKey — SecretStorage key derivation', () => {
  it('cloud connection uses the legacy ollamaCloud.apiKey key', () => {
    assert.equal(apiKeySecretKey(CLOUD_CONNECTION_ID), 'ollamaCloud.apiKey');
  });

  it('non-cloud connection uses ollamaCloud.apiKey.<id>', () => {
    assert.equal(apiKeySecretKey('vps1'), 'ollamaCloud.apiKey.vps1');
    assert.equal(apiKeySecretKey('home'), 'ollamaCloud.apiKey.home');
  });

  it('cloud id is stable regardless of casing in the source (uses the constant)', () => {
    // The constant is 'cloud' (lowercase). The function compares against
    // the constant, so a literal 'cloud' is the only match.
    assert.equal(apiKeySecretKey('cloud'), 'ollamaCloud.apiKey');
    assert.equal(apiKeySecretKey('Cloud'), 'ollamaCloud.apiKey.Cloud');
  });
});

describe('connections.modelIdPrefix / connectionOriginLabel — model picker', () => {
  function makeConn(
    id: string,
    type: ConnectionConfig['type'],
  ): ConnectionConfig {
    return {
      id,
      label: id,
      type,
      enabled: true,
      baseUrl: 'https://example.com/v1',
      openaiCompatiblePath: '',
      allowedBaseUrls: ['https://example.com/v1'],
      visionModels: [],
      requiresApiKey: true,
    };
  }

  it('cloud connection keeps the legacy ollama-cloud/ prefix', () => {
    assert.equal(modelIdPrefix(makeConn('cloud', 'cloud')), 'ollama-cloud/');
  });

  it('non-cloud connection uses ollama-cloud/<id>/ prefix', () => {
    assert.equal(
      modelIdPrefix(makeConn('vps1', 'remote')),
      'ollama-cloud/vps1/',
    );
    assert.equal(
      modelIdPrefix(makeConn('home', 'local')),
      'ollama-cloud/home/',
    );
  });

  it('origin label is Cloud / Local / VPS / custom per type', () => {
    assert.equal(connectionOriginLabel(makeConn('cloud', 'cloud')), 'Cloud');
    assert.equal(connectionOriginLabel(makeConn('home', 'local')), 'Local');
    assert.equal(connectionOriginLabel(makeConn('vps1', 'remote')), 'VPS');
    assert.equal(connectionOriginLabel(makeConn('custom1', 'custom')), 'custom');
  });
});

describe('connections.parseModelId — id → connectionId + apiModel', () => {
  it('parses a cloud model id (no connection segment)', () => {
    const parsed = parseModelId('ollama-cloud/gpt-oss:120b');
    assert.deepEqual(parsed, { connectionId: 'cloud', apiModel: 'gpt-oss:120b' });
  });

  it('parses a non-cloud model id (with connection segment)', () => {
    const parsed = parseModelId('ollama-cloud/vps1/gpt-oss:120b');
    assert.deepEqual(parsed, { connectionId: 'vps1', apiModel: 'gpt-oss:120b' });
  });

  it('parses a non-cloud id where the apiModel contains a slash', () => {
    // apiModel itself may contain ':' but not '/'. A slash separates
    // the connectionId from the apiModel.
    const parsed = parseModelId('ollama-cloud/home/llama3:8b');
    assert.deepEqual(parsed, { connectionId: 'home', apiModel: 'llama3:8b' });
  });

  it('returns undefined for a non-prefixed id', () => {
    assert.equal(parseModelId('something-else/gpt-oss:120b'), undefined);
    assert.equal(parseModelId('gpt-oss:120b'), undefined);
  });
});

describe('connections.openAiBaseUrl — baseUrl + openaiCompatiblePath', () => {
  function makeConn(
    baseUrl: string,
    openaiCompatiblePath: string,
  ): ConnectionConfig {
    return {
      id: 'test',
      label: 'test',
      type: 'remote',
      enabled: true,
      baseUrl,
      openaiCompatiblePath,
      allowedBaseUrls: [baseUrl],
      visionModels: [],
      requiresApiKey: true,
    };
  }

  it('returns baseUrl when openaiCompatiblePath is empty', () => {
    assert.equal(
      openAiBaseUrl(makeConn('https://vps.example.com/v1', '')),
      'https://vps.example.com/v1',
    );
  });

  it('appends openaiCompatiblePath when set', () => {
    assert.equal(
      openAiBaseUrl(makeConn('https://vps.example.com', '/v1')),
      'https://vps.example.com/v1',
    );
  });
});