import * as vscode from 'vscode';

/**
 * Multi-connection support — Cloud, Local, VPS, and custom
 * OpenAI-compatible endpoints, adapted to this extension's security
 * contract (per-connection `allowedBaseUrls` whitelist,
 * `scope: "application"` settings, no external reporting calls, no
 * remote call execution primitives).
 *
 * Design:
 *   - The legacy single-connection settings (`ollamaCloud.baseUrl` +
 *     `ollamaCloud.allowedBaseUrls`) keep working as the implicit
 *     "cloud" connection. When `ollamaCloud.connections` is empty or
 *     absent, the extension behaves exactly as before — the 192
 *     existing tests stay green.
 *   - When `ollamaCloud.connections` is populated, each entry is a
 *     distinct connection (Cloud, Local, VPS, or custom OpenAI-
 *     compatible endpoint). Each connection carries its OWN
 *     `allowedBaseUrls` whitelist, enforced fail-closed at every
 *     fetch boundary (see `configValidator.assertBaseUrlAllowedForConnection`).
 *   - Each connection has its own API key in SecretStorage, keyed
 *     `ollamaCloud.apiKey.<connectionId>`. The cloud connection keeps
 *     the legacy `ollamaCloud.apiKey` secret for backward compatibility.
 */

/**
 * Connection type — drives the origin label shown in the model picker
 * (Cloud: / Local: / VPS: / custom) and the default `allowedBaseUrls`
 * resolution when the user does not declare one.
 */
export type ConnectionType = 'cloud' | 'local' | 'remote' | 'custom';

/**
 * A normalized, validated connection configuration.
 *
 * `allowedBaseUrls` is the per-connection whitelist. It is ALWAYS
 * populated after normalization — never undefined. If the user does
 * not declare one, the normalizer picks a fail-closed default:
 *   - cloud  → the global `ollamaCloud.allowedBaseUrls` (legacy)
 *   - local  → `[connection.baseUrl]`
 *   - remote → `[connection.baseUrl]`
 *   - custom → `[connection.baseUrl]`
 *
 * `visionModels` is the per-connection vision override. If absent,
 * the global `ollamaCloud.visionModels` patterns apply.
 */
export interface ConnectionConfig {
  /** Stable id used as the SecretStorage key suffix and the model id prefix. */
  readonly id: string;
  /** Human-readable label shown in the model picker origin tag. */
  readonly label: string;
  /** Connection type — drives the origin label and default whitelist. */
  readonly type: ConnectionType;
  /** Whether the connection is enabled. Disabled connections are skipped. */
  readonly enabled: boolean;
  /** OpenAI-compatible base URL (e.g. `https://ollama.com/v1`). */
  readonly baseUrl: string;
  /**
   * OpenAI-compatible path suffix. Defaults to `''` (the baseUrl already
   * includes `/v1` for cloud). For local/remote Ollama, the user may
   * point baseUrl at the root and set this to `/v1`.
   */
  readonly openaiCompatiblePath: string;
  /** Per-connection whitelist. Always populated after normalization. */
  readonly allowedBaseUrls: readonly string[];
  /** Per-connection vision wildcard patterns. May be empty. */
  readonly visionModels: readonly string[];
  /** Whether an API key is required for this connection. */
  readonly requiresApiKey: boolean;
}

/**
 * The cloud connection id — stable across sessions so the SecretStorage
 * key `ollamaCloud.apiKey.cloud` (and the legacy `ollamaCloud.apiKey`)
 * resolves to the same connection.
 */
export const CLOUD_CONNECTION_ID = 'cloud';

const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';
const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434';
const DEFAULT_OPENAI_PATH = '';

/**
 * Reads and normalizes the full connection list from VS Code configuration.
 *
 * Always returns at least the cloud connection (synthesized from the
 * legacy `ollamaCloud.baseUrl` + `ollamaCloud.allowedBaseUrls` settings
 * when `ollamaCloud.connections` is empty/absent). This guarantees the
 * 192 existing tests — which configure only the legacy settings — keep
 * working without modification.
 *
 * Disabled connections are filtered out.
 */
export function loadConnections(): ConnectionConfig[] {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const rawConnections = config.get<unknown[]>('connections') ?? [];
  const globalAllowed = readGlobalAllowedBaseUrls();
  const globalVision = readStringList(config, 'visionModels');

  const connections: ConnectionConfig[] = [];

  // Cloud connection — always present. If the user declared a
  // connection with id "cloud" in the `connections` array, it overrides
  // the synthesized cloud connection (so power users can change the
  // cloud baseUrl). Otherwise synthesize from legacy settings.
  const declaredCloud = Array.isArray(rawConnections)
    ? rawConnections.find(findCloudEntry)
    : undefined;

  if (declaredCloud) {
    const normalized = normalizeConnection(declaredCloud, globalAllowed, globalVision);
    if (normalized) {
      connections.push(normalized);
    }
  } else {
    connections.push(synthesizeCloudConnection(globalAllowed, globalVision));
  }

  // Non-cloud connections from the `connections` array.
  if (Array.isArray(rawConnections)) {
    for (const entry of rawConnections) {
      if (findCloudEntry(entry)) {
        continue;
      }
      const normalized = normalizeConnection(entry, globalAllowed, globalVision);
      if (normalized) {
        connections.push(normalized);
      }
    }
  }

  return connections.filter((connection) => connection.enabled);
}

/**
 * Returns the connection whose `id` matches `connectionId`, or
 * `undefined` if no such connection exists.
 */
export function findConnection(
  connections: readonly ConnectionConfig[],
  connectionId: string,
): ConnectionConfig | undefined {
  return connections.find((connection) => connection.id === connectionId);
}

/**
 * Returns the origin label prefix for a connection — shown in the
 * model picker before the model name (e.g. `Cloud:gpt-oss:120b`).
 */
export function connectionOriginLabel(connection: ConnectionConfig): string {
  switch (connection.type) {
    case 'cloud':
      return 'Cloud';
    case 'local':
      return 'Local';
    case 'remote':
      return 'VPS';
    case 'custom':
      return 'custom';
    default:
      return connection.label;
  }
}

/**
 * Builds the model id prefix for a connection. The cloud connection
 * keeps the legacy `ollama-cloud/` prefix (so existing tests and
 * stored model selections resolve). Non-cloud connections use
 * `ollama-cloud/<connectionId>/` to keep model ids unique across
 * connections even when two connections expose the same model name.
 */
export function modelIdPrefix(connection: ConnectionConfig): string {
  if (connection.type === 'cloud') {
    return 'ollama-cloud/';
  }
  return `ollama-cloud/${connection.id}/`;
}

/**
 * Builds the SecretStorage key for a connection's API key.
 *
 * The cloud connection keeps the legacy `ollamaCloud.apiKey` key for
 * backward compatibility. Non-cloud connections use
 * `ollamaCloud.apiKey.<connectionId>`.
 */
export function apiKeySecretKey(connectionId: string): string {
  if (connectionId === CLOUD_CONNECTION_ID) {
    return 'ollamaCloud.apiKey';
  }
  return `ollamaCloud.apiKey.${connectionId}`;
}

/**
 * Parses a model id back into its connection id + apiModel. Returns
 * `undefined` if the id does not match the expected prefix shape.
 */
export function parseModelId(
  id: string,
): { connectionId: string; apiModel: string } | undefined {
  if (!id.startsWith('ollama-cloud/')) {
    return undefined;
  }
  const rest = id.slice('ollama-cloud/'.length);
  // Cloud connection: `ollama-cloud/<apiModel>` (no extra segment).
  // Non-cloud: `ollama-cloud/<connectionId>/<apiModel>`.
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return { connectionId: CLOUD_CONNECTION_ID, apiModel: rest };
  }
  return {
    connectionId: rest.slice(0, slash),
    apiModel: rest.slice(slash + 1),
  };
}

/**
 * Synthesizes the cloud connection from the legacy settings. This is
 * the backward-compatibility path — when `ollamaCloud.connections` is
 * empty/absent, the cloud connection is built from `ollamaCloud.baseUrl`
 * + `ollamaCloud.allowedBaseUrls` exactly as before.
 */
function synthesizeCloudConnection(
  globalAllowed: readonly string[],
  globalVision: readonly string[],
): ConnectionConfig {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const configuredBaseUrl = config.get<string>('baseUrl');
  const baseUrl = normalizeBaseUrl(
    configuredBaseUrl && configuredBaseUrl.trim()
      ? configuredBaseUrl
      : DEFAULT_CLOUD_BASE_URL,
  );
  return {
    id: CLOUD_CONNECTION_ID,
    label: 'Cloud',
    type: 'cloud',
    enabled: true,
    baseUrl,
    openaiCompatiblePath: DEFAULT_OPENAI_PATH,
    allowedBaseUrls: globalAllowed.length > 0 ? globalAllowed : [baseUrl],
    visionModels: globalVision,
    requiresApiKey: true,
  };
}

/**
 * Normalizes a raw connection entry from `ollamaCloud.connections`.
 * Returns `undefined` if the entry is not a valid connection object.
 *
 * The `globalAllowed` and `globalVision` parameters are the global
 * settings used as fallbacks for the cloud connection's whitelist and
 * vision patterns respectively.
 */
function normalizeConnection(
  value: unknown,
  globalAllowed: readonly string[],
  globalVision: readonly string[],
): ConnectionConfig | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;

  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  if (!rawId) {
    return undefined;
  }
  // Slugify the id — only [a-z0-9-_] allowed (it lands in a SecretStorage
  // key and a model id prefix).
  const id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!id) {
    return undefined;
  }

  const type = normalizeConnectionType(record.type, record.baseUrl);
  const baseUrl = normalizeBaseUrl(
    typeof record.baseUrl === 'string' && record.baseUrl.trim()
      ? record.baseUrl
      : defaultBaseUrlForType(type),
  );
  const openaiCompatiblePath =
    typeof record.openaiCompatiblePath === 'string'
      ? normalizePath(record.openaiCompatiblePath)
      : DEFAULT_OPENAI_PATH;

  // Per-connection whitelist. Fail-closed default: only the connection's
  // own baseUrl. The cloud connection inherits the global whitelist for
  // backward compatibility.
  const rawAllowed = record.allowedBaseUrls;
  let allowed: readonly string[];
  if (Array.isArray(rawAllowed)) {
    allowed = rawAllowed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => normalizeBaseUrl(entry))
      .filter((entry) => entry.length > 0);
  } else if (type === 'cloud') {
    allowed = globalAllowed.length > 0 ? globalAllowed : [baseUrl];
  } else {
    allowed = [baseUrl];
  }

  const rawVision = record.visionModels;
  const visionModels = Array.isArray(rawVision)
    ? rawVision
        .filter((entry): entry is string => typeof entry === 'string')
        .filter((entry) => entry.trim().length > 0)
    : type === 'cloud'
      ? globalVision
      : [];

  const label =
    typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : defaultLabelForType(type);

  const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;
  const requiresApiKey =
    typeof record.requiresApiKey === 'boolean'
      ? record.requiresApiKey
      : type === 'cloud' || type === 'remote' || type === 'custom';

  return {
    id,
    label,
    type,
    enabled,
    baseUrl,
    openaiCompatiblePath,
    allowedBaseUrls: allowed,
    visionModels,
    requiresApiKey,
  };
}

function normalizeConnectionType(
  value: unknown,
  baseUrl: unknown,
): ConnectionType {
  if (
    value === 'cloud' ||
    value === 'local' ||
    value === 'remote' ||
    value === 'custom'
  ) {
    return value;
  }
  // Infer from baseUrl: localhost → local, ollama.com → cloud, else remote.
  if (typeof baseUrl === 'string') {
    const normalized = baseUrl.toLowerCase();
    if (isLocalBaseUrl(normalized)) {
      return 'local';
    }
    if (isOllamaCloudUrl(normalized)) {
      return 'cloud';
    }
    return 'remote';
  }
  return 'remote';
}

function defaultBaseUrlForType(type: ConnectionType): string {
  return type === 'cloud' ? DEFAULT_CLOUD_BASE_URL : DEFAULT_LOCAL_BASE_URL;
}

function defaultLabelForType(type: ConnectionType): string {
  switch (type) {
    case 'cloud':
      return 'Cloud';
    case 'local':
      return 'Local';
    case 'remote':
      return 'VPS';
    case 'custom':
      return 'custom';
    default:
      return 'Connection';
  }
}

function findCloudEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (record.id === CLOUD_CONNECTION_ID) {
    return true;
  }
  const type = record.type;
  if (type === 'cloud') {
    return true;
  }
  if (typeof record.baseUrl === 'string' && isOllamaCloudUrl(record.baseUrl)) {
    return true;
  }
  return false;
}

function isOllamaCloudUrl(value: string): boolean {
  return /^https:\/\/ollama\.com\/?/i.test(value);
}

function isLocalBaseUrl(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(value);
}

function readGlobalAllowedBaseUrls(): readonly string[] {
  const config = vscode.workspace.getConfiguration('ollamaCloud');
  const allowed = config.get<string[]>('allowedBaseUrls');
  if (!allowed || allowed.length === 0) {
    return [DEFAULT_CLOUD_BASE_URL];
  }
  return allowed.map(normalizeBaseUrl).filter((entry) => entry.length > 0);
}

function readStringList(
  config: vscode.WorkspaceConfiguration,
  key: string,
): readonly string[] {
  const value = config.get<unknown[]>(key) ?? [];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry.trim().length > 0);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Returns the full OpenAI-compatible base URL for a connection —
 * `baseUrl + openaiCompatiblePath`. Used by fetch boundaries to build
 * the `/chat/completions` and `/models` URLs.
 */
export function openAiBaseUrl(connection: ConnectionConfig): string {
  return `${connection.baseUrl}${connection.openaiCompatiblePath}`;
}

/**
 * Returns the root URL for a connection — baseUrl with `/v1` stripped
 * from the path (for the native Ollama `/api/tags` endpoint fallback).
 */
export function rootUrlForConnection(connection: ConnectionConfig): string {
  const full = openAiBaseUrl(connection);
  try {
    const url = new URL(full);
    url.pathname = url.pathname.replace(/\/v1\/?$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return full.replace(/\/v1\/?$/, '');
  }
}