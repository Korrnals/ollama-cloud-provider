import { AuthManager } from './auth.js';
import { assertBaseUrlAllowed, assertBaseUrlAllowedForConnection } from './configValidator.js';
import {
  connectionOriginLabel,
  type ConnectionConfig,
  modelIdPrefix,
  openAiBaseUrl,
  rootUrlForConnection,
} from './connections.js';
import { logger } from './logger.js';
import { httpErrorFromResponse, withRetry } from './retry.js';

const MODELS_ENDPOINT_SUFFIX = '/models';
const TAGS_ENDPOINT_SUFFIX = '/api/tags';
const DEFAULT_DETAIL = 'Ollama Cloud';
// INFO-3 — explicit timeout for catalog fetches. Without it, a hung
// endpoint blocks model discovery indefinitely. 30s is generous for a
// one-shot JSON catalog pull and short enough to fail fast visibly.
const CATALOG_FETCH_TIMEOUT_MS = 30000;

export interface ModelDefinition {
  id: string;
  apiModel: string;
  name: string;
  family: string;
  version: string;
  detail: string;
  /**
   * Connection id this model belongs to. Cloud connection uses the
   * legacy `ollama-cloud/` id prefix (no connection segment in the id),
   * so this field is the source of truth for which connection owns a
   * model. `provider.ts` reads this to resolve the connection when
   * streaming a chat request.
   */
  connectionId: string;
  /**
   * Origin label shown in the model picker — e.g. `Cloud`, `Local`,
   * `VPS`, `custom`. The provider prepends it to the model name so
   * the picker shows `Cloud:gpt-oss:120b`, `Local:llama3:8b`, etc.
   */
  origin: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoning: boolean;
  capabilities: {
    imageInput: boolean;
    toolCalling: boolean | number;
  };
}

interface SnapshotModelDefinition {
  apiModel: string;
  family?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  imageInput?: boolean;
  toolCalling?: boolean;
}

const HUMANIZED_SEGMENTS: Record<string, string> = {
  cogito: 'Cogito',
  deepseek: 'DeepSeek',
  devstral: 'Devstral',
  flash: 'Flash',
  gemini: 'Gemini',
  gemma: 'Gemma',
  glm: 'GLM',
  gpt: 'GPT',
  oss: 'OSS',
  instruct: 'Instruct',
  kimi: 'Kimi',
  large: 'Large',
  minimax: 'MiniMax',
  ministral: 'Ministral',
  mistral: 'Mistral',
  nano: 'Nano',
  nemotron: 'Nemotron',
  next: 'Next',
  preview: 'Preview',
  pro: 'Pro',
  qwen: 'Qwen',
  rnj: 'RNJ',
  small: 'Small',
  super: 'Super',
  thinking: 'Thinking',
  vl: 'VL',
};

const SNAPSHOT_MODELS: readonly SnapshotModelDefinition[] = [
  {
    apiModel: 'cogito-2.1:671b',
    family: 'cogito',
    maxInputTokens: 163840,
    maxOutputTokens: 32000,
    imageInput: false,
    toolCalling: true,
    reasoning: false,
  },
  {
    apiModel: 'deepseek-v3.1:671b',
    family: 'deepseek',
    maxInputTokens: 163840,
    maxOutputTokens: 163840,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'deepseek-v3.2',
    family: 'deepseek',
    maxInputTokens: 163840,
    maxOutputTokens: 65536,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'deepseek-v4-flash',
    family: 'deepseek',
    maxInputTokens: 1000000,
    maxOutputTokens: 384000,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'deepseek-v4-pro',
    family: 'deepseek',
    maxInputTokens: 1000000,
    maxOutputTokens: 384000,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'devstral-2:123b',
    family: 'devstral',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'devstral-small-2:24b',
    family: 'devstral',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'gemini-3-flash-preview',
    family: 'gemini',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'gemma3:12b',
    family: 'gemma',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    imageInput: true,
    toolCalling: false,
  },
  {
    apiModel: 'gemma3:27b',
    family: 'gemma',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    imageInput: true,
    toolCalling: false,
  },
  {
    apiModel: 'gemma3:4b',
    family: 'gemma',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    imageInput: true,
    toolCalling: false,
  },
  {
    apiModel: 'gemma4:31b',
    family: 'gemma',
    maxInputTokens: 262144,
    maxOutputTokens: 131072,
    imageInput: true,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'glm-4.6',
    family: 'glm',
    maxInputTokens: 202752,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'glm-4.7',
    family: 'glm',
    maxInputTokens: 202752,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'glm-5',
    family: 'glm',
    maxInputTokens: 202752,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'glm-5.1',
    family: 'glm',
    maxInputTokens: 202752,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'glm-5.2',
    family: 'glm',
    maxInputTokens: 1000000,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'gpt-oss:120b',
    family: 'gpt-oss',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'gpt-oss:20b',
    family: 'gpt-oss',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'kimi-k2.5',
    family: 'kimi',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'kimi-k2.6',
    family: 'kimi',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'kimi-k2.7-code',
    family: 'kimi',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: true,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'kimi-k2:1t',
    family: 'kimi',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'kimi-k2-thinking',
    family: 'kimi',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'minimax-m2',
    family: 'minimax',
    maxInputTokens: 204800,
    maxOutputTokens: 128000,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'minimax-m2.1',
    family: 'minimax',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'minimax-m2.5',
    family: 'minimax',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'minimax-m2.7',
    family: 'minimax',
    maxInputTokens: 204800,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'minimax-m3',
    family: 'minimax',
    maxInputTokens: 524288,
    maxOutputTokens: 131072,
    imageInput: true,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'ministral-3:14b',
    family: 'ministral',
    maxInputTokens: 262144,
    maxOutputTokens: 128000,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'ministral-3:3b',
    family: 'ministral',
    maxInputTokens: 262144,
    maxOutputTokens: 128000,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'ministral-3:8b',
    family: 'ministral',
    maxInputTokens: 262144,
    maxOutputTokens: 128000,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'mistral-large-3:675b',
    family: 'mistral-large',
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'nemotron-3-nano:30b',
    family: 'nemotron',
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'nemotron-3-super',
    family: 'nemotron',
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'nemotron-3-ultra',
    family: 'nemotron',
    maxInputTokens: 262144,
    maxOutputTokens: 131072,
    imageInput: false,
    toolCalling: true,
    reasoning: true,
  },
  {
    apiModel: 'qwen3.5:397b',
    family: 'qwen',
    maxInputTokens: 262144,
    maxOutputTokens: 81920,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'qwen3-coder:480b',
    family: 'qwen',
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'qwen3-coder-next',
    family: 'qwen',
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'qwen3-next:80b',
    family: 'qwen',
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    imageInput: false,
    toolCalling: true,
  },
  {
    apiModel: 'qwen3-vl:235b',
    family: 'qwen',
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'qwen3-vl:235b-instruct',
    family: 'qwen',
    maxInputTokens: 262144,
    maxOutputTokens: 131072,
    imageInput: true,
    toolCalling: true,
  },
  {
    apiModel: 'rnj-1:8b',
    family: 'rnj',
    maxInputTokens: 32768,
    maxOutputTokens: 4096,
    imageInput: false,
    toolCalling: true,
  },
];

const KNOWN_MODELS = SNAPSHOT_MODELS.map(defineModel);
const KNOWN_MODEL_MAP = new Map(
  KNOWN_MODELS.flatMap((model) => [
    [model.id, model],
    [model.apiModel, model],
  ]),
);

export class ModelCatalog {
  private models: ModelDefinition[] = [...KNOWN_MODELS];

  constructor(private readonly authManager: AuthManager) {}

  list(): readonly ModelDefinition[] {
    return this.models;
  }

  get(id: string): ModelDefinition | undefined {
    return this.models.find((model) => model.id === id);
  }

  async refresh(): Promise<{ changed: boolean; count: number }> {
    const ids = await this.fetchModelIds();
    const nextModels = ids.map(
      (id) => KNOWN_MODEL_MAP.get(id) || inferModel(id),
    );
    const changed = !sameModelIds(this.models, nextModels);
    this.models = nextModels;

    return { changed, count: nextModels.length };
  }

  /**
   * Multi-connection refresh — discovers models for every connection in
   * `connections`, merges them with the known snapshot models, and
   * returns the merged list. Cloud connection models keep the legacy
   * `ollama-cloud/<apiModel>` id; non-cloud connection models use
   * `ollama-cloud/<connectionId>/<apiModel>`.
   *
   * Per-connection `allowedBaseUrls` is enforced fail-closed at every
   * fetch boundary (`assertBaseUrlAllowedForConnection`). If a
   * connection's baseUrl is not whitelisted, its discovery is skipped
   * (logged) and its models do not appear — the API key is never sent
   * to a non-whitelisted host.
   */
  async refreshForConnections(
    connections: readonly ConnectionConfig[],
  ): Promise<{ changed: boolean; count: number }> {
    const nextModels: ModelDefinition[] = [...KNOWN_MODELS];

    for (const connection of connections) {
      try {
        const ids = await this.fetchModelIdsForConnection(connection);
        for (const apiModel of ids) {
          const known = KNOWN_MODEL_MAP.get(apiModel);
          const model = known
            ? withConnection(known, connection)
            : inferModelForConnection(apiModel, connection);
          // Dedupe by id — if two connections expose the same apiModel,
          // the connectionId segment in the id makes them distinct.
          if (!nextModels.some((m) => m.id === model.id)) {
            nextModels.push(model);
          }
        }
      } catch (error) {
        // Per-connection failures are logged + skipped — one bad
        // connection must not break discovery for the others. The
        // error is already redacted if it came from the HTTP layer
        // (extractErrorMessage → redactSensitive).
        logger.warn(
          `Failed to refresh models for connection '${connection.id}'.`,
          error,
        );
      }
    }

    const changed = !sameModelIds(this.models, nextModels);
    this.models = nextModels;
    return { changed, count: nextModels.length };
  }

  private async fetchModelIds(): Promise<string[]> {
    const apiKey = await this.authManager.getApiKey();
    const baseUrl = this.authManager.getBaseUrl();
    const rootUrl = this.authManager.getRootUrl();

    // Issue 9 — security boundary: refuse to send the API key to any
    // host not in the whitelist. One check here covers both the
    // /v1/models request and the /api/tags fallback, because rootUrl is
    // derived from baseUrl in AuthManager.getRootUrl. If baseUrl is not
    // whitelisted, neither endpoint is safe.
    assertBaseUrlAllowed(baseUrl);

    try {
      return await fetchModelIdsFromOpenAICatalog(baseUrl, apiKey);
    } catch (error) {
      logger.warn(
        'Failed to fetch Ollama Cloud catalog from /v1/models. Falling back to /api/tags.',
        error,
      );
    }

    return fetchModelIdsFromTagsCatalog(rootUrl, apiKey);
  }

  /**
   * Per-connection model discovery. Tries the OpenAI `/models`
   * endpoint first, then falls back to the native Ollama `/api/tags`
   * endpoint. Each fetch boundary enforces the connection's own
   * whitelist via `assertBaseUrlAllowedForConnection` — fail-closed.
   */
  private async fetchModelIdsForConnection(
    connection: ConnectionConfig,
  ): Promise<string[]> {
    const openaiBase = openAiBaseUrl(connection);
    const rootUrl = rootUrlForConnection(connection);

    // SEC-03 per-connection gate — the API key for this connection is
    // never sent to a host not in the connection's own whitelist.
    assertBaseUrlAllowedForConnection(openaiBase, connection);

    const apiKey = await this.authManager.getApiKeyForConnection(connection);

    try {
      return await fetchModelIdsFromOpenAICatalog(openaiBase, apiKey);
    } catch (error) {
      logger.warn(
        `Failed to fetch catalog from /v1/models for connection '${connection.id}'. Falling back to /api/tags.`,
        error,
      );
    }

    return fetchModelIdsFromTagsCatalog(rootUrl, apiKey);
  }
}

function defineModel(model: SnapshotModelDefinition): ModelDefinition {
  const family = model.family || inferFamily(model.apiModel);

  return {
    id: withProviderPrefix(model.apiModel),
    apiModel: model.apiModel,
    name: humanizeModelId(model.apiModel),
    family,
    version: inferVersion(model.apiModel, family),
    detail: DEFAULT_DETAIL,
    connectionId: 'cloud',
    origin: 'Cloud',
    maxInputTokens: model.maxInputTokens ?? inferMaxInputTokens(model.apiModel),
    maxOutputTokens:
      model.maxOutputTokens ?? inferMaxOutputTokens(model.apiModel),
    reasoning: model.reasoning ?? inferReasoning(model.apiModel),
    capabilities: {
      imageInput: model.imageInput ?? inferImageInput(model.apiModel),
      toolCalling: model.toolCalling ?? inferToolCalling(model.apiModel),
    },
  };
}

function withProviderPrefix(id: string): string {
  return `ollama-cloud/${id}`;
}

function sameModelIds(
  current: readonly ModelDefinition[],
  next: readonly ModelDefinition[],
): boolean {
  if (current.length !== next.length) {
    return false;
  }

  return current.every((model, index) => model.id === next[index]?.id);
}

function inferModel(id: string): ModelDefinition {
  const family = inferFamily(id);

  return {
    id: withProviderPrefix(id),
    apiModel: id,
    name: humanizeModelId(id),
    family,
    version: inferVersion(id, family),
    detail: DEFAULT_DETAIL,
    connectionId: 'cloud',
    origin: 'Cloud',
    maxInputTokens: inferMaxInputTokens(id),
    maxOutputTokens: inferMaxOutputTokens(id),
    reasoning: inferReasoning(id),
    capabilities: {
      imageInput: inferImageInput(id),
      toolCalling: inferToolCalling(id),
    },
  };
}

/**
 * Adapts a known snapshot model for a non-cloud connection — rewrites
 * the id prefix and the origin label so the model picker shows the
 * correct origin. The vision support is re-resolved against the
 * connection's own `visionModels` patterns (a connection may mark a
 * model as vision-capable even when the snapshot does not).
 */
function withConnection(
  known: ModelDefinition,
  connection: ConnectionConfig,
): ModelDefinition {
  const prefix = modelIdPrefix(connection);
  const id = `${prefix}${known.apiModel}`;
  const origin = connectionOriginLabel(connection);
  const imageInput = resolveVisionSupport(
    known,
    connection.visionModels,
  );
  return {
    ...known,
    id,
    connectionId: connection.id,
    origin,
    capabilities: { ...known.capabilities, imageInput },
  };
}

/**
 * Infers a `ModelDefinition` for a model discovered on a non-cloud
 * connection (no snapshot entry). The id is prefixed with the
 * connection's segment so two connections exposing the same model
 * name do not collide.
 */
function inferModelForConnection(
  apiModel: string,
  connection: ConnectionConfig,
): ModelDefinition {
  const family = inferFamily(apiModel);
  const prefix = modelIdPrefix(connection);
  const id = `${prefix}${apiModel}`;
  const origin = connectionOriginLabel(connection);
  const baseImageInput = inferImageInput(apiModel);
  const imageInput =
    baseImageInput ||
    inferVisionSupport(apiModel, family) ||
    matchesConfiguredVisionModel(apiModel, connection.visionModels);

  return {
    id,
    apiModel,
    name: humanizeModelId(apiModel),
    family,
    version: inferVersion(apiModel, family),
    detail: connection.label,
    connectionId: connection.id,
    origin,
    maxInputTokens: inferMaxInputTokens(apiModel),
    maxOutputTokens: inferMaxOutputTokens(apiModel),
    reasoning: inferReasoning(apiModel),
    capabilities: {
      imageInput,
      toolCalling: inferToolCalling(apiModel),
    },
  };
}



async function fetchModelIdsFromOpenAICatalog(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  // Issue 9 — assert enforced by caller (fetchModelIds) before this
  // function is reached, so the API key is never sent to a non-
  // whitelisted host. Defense in depth: the check lives at the request
  // boundary, not at activation.
  // Issue 13 — wrapped in withRetry for transient 429/5xx/network
  // failures. This is a one-shot JSON fetch (not a stream), so retrying
  // the whole call is safe.
  // INFO-3 — explicit 30s timeout. Without it, a hung catalog endpoint
  // would block model discovery indefinitely. withRetry would keep
  // retrying a never-resolving fetch, multiplying the stall.
  const response = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      CATALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${baseUrl}${MODELS_ENDPOINT_SUFFIX}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw await httpErrorFromResponse(
          res,
          `Model catalog request failed with HTTP ${res.status}.`,
        );
      }
      return res;
    } finally {
      clearTimeout(timeoutHandle);
    }
  });

  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = payload.data
    ?.map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id));

  if (!ids || ids.length === 0) {
    throw new Error('Ollama Cloud returned an empty /v1/models catalog.');
  }

  return unique(ids);
}

async function fetchModelIdsFromTagsCatalog(
  rootUrl: string,
  apiKey?: string,
): Promise<string[]> {
  // Issue 13 — same retry treatment as the OpenAI catalog fetch.
  // INFO-3 — explicit 30s timeout, same rationale as the OpenAI
  // catalog helper: a hung /api/tags endpoint must not block model
  // discovery indefinitely.
  const response = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      CATALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${rootUrl}${TAGS_ENDPOINT_SUFFIX}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw await httpErrorFromResponse(
          res,
          `Tags catalog request failed with HTTP ${res.status}.`,
        );
      }
      return res;
    } finally {
      clearTimeout(timeoutHandle);
    }
  });

  const payload = (await response.json()) as {
    models?: Array<{ model?: string; name?: string }>;
  };
  const ids = payload.models
    ?.map((entry) => entry.model?.trim() || entry.name?.trim())
    .filter((id): id is string => Boolean(id));

  if (!ids || ids.length === 0) {
    throw new Error('Ollama Cloud returned an empty /api/tags catalog.');
  }

  return unique(ids);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function humanizeModelId(id: string): string {
  return id
    .split('-')
    .map((segment) => humanizeSegment(segment))
    .join(' ');
}

function humanizeSegment(segment: string): string {
  if (segment.includes(':')) {
    return segment
      .split(':')
      .map((part) => humanizeSegment(part))
      .join(':');
  }

  const exact = HUMANIZED_SEGMENTS[segment];
  if (exact) {
    return exact;
  }

  const alphaNumeric = /^([a-z]+)(\d+(?:\.\d+)?)$/i.exec(segment);
  if (alphaNumeric) {
    const [, prefix, suffix] = alphaNumeric;
    return `${capitalizeKnown(prefix)}${suffix}`;
  }

  if (/^\d+(?:\.\d+)?[bt]$/i.test(segment)) {
    return segment.toUpperCase();
  }

  if (/^[vmk]\d+(?:\.\d+)?$/i.test(segment)) {
    return segment.charAt(0).toUpperCase() + segment.slice(1);
  }

  return capitalizeKnown(segment);
}

function capitalizeKnown(value: string): string {
  const lower = value.toLowerCase();
  const known = HUMANIZED_SEGMENTS[lower];
  if (known) {
    return known;
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function inferFamily(id: string): string {
  if (id.startsWith('cogito-')) {
    return 'cogito';
  }
  if (id.startsWith('deepseek-')) {
    return 'deepseek';
  }
  if (id.startsWith('devstral')) {
    return 'devstral';
  }
  if (id.startsWith('gemini-')) {
    return 'gemini';
  }
  if (id.startsWith('gemma')) {
    return 'gemma';
  }
  if (id.startsWith('glm-')) {
    return 'glm';
  }
  if (id.startsWith('gpt-oss')) {
    return 'gpt-oss';
  }
  if (id.startsWith('kimi-')) {
    return 'kimi';
  }
  if (id.startsWith('minimax-')) {
    return 'minimax';
  }
  if (id.startsWith('ministral-')) {
    return 'ministral';
  }
  if (id.startsWith('mistral-')) {
    return 'mistral';
  }
  if (id.startsWith('nemotron-')) {
    return 'nemotron';
  }
  if (id.startsWith('qwen')) {
    return 'qwen';
  }
  if (id.startsWith('rnj-')) {
    return 'rnj';
  }

  return 'ollama-cloud';
}

export function inferVersion(id: string, family: string): string {
  if (id.startsWith(`${family}-`)) {
    return id.slice(family.length + 1);
  }

  if (id.startsWith(`${family}:`)) {
    return id.slice(family.length + 1);
  }

  if (family === 'gemma' || family === 'qwen' || family === 'gpt-oss') {
    return id.slice(family.length);
  }

  return id;
}

export function inferMaxInputTokens(id: string): number {
  if (
    id.startsWith('deepseek-v4-') ||
    id.startsWith('gemini-3-flash-preview') ||
    id.startsWith('nemotron-3-nano')
  ) {
    return 1048576;
  }
  if (id.startsWith('deepseek-')) {
    return 163840;
  }
  if (
    id.startsWith('devstral-') ||
    id.startsWith('kimi-') ||
    id.startsWith('ministral-') ||
    id.startsWith('mistral-large-') ||
    id.startsWith('nemotron-3-ultra') ||
    id.startsWith('qwen')
  ) {
    return 262144;
  }
  if (id.startsWith('glm-5.2')) {
    return 1000000;
  }
  if (id.startsWith('glm-')) {
    return 202752;
  }
  if (id.startsWith('minimax-m3')) {
    return 524288;
  }
  if (id.startsWith('minimax-')) {
    return 204800;
  }
  if (id.startsWith('gpt-oss')) {
    return 131072;
  }
  if (id.startsWith('gemma4:')) {
    return 262144;
  }
  if (id.startsWith('gemma3:')) {
    return 131072;
  }
  if (id.startsWith('rnj-')) {
    return 32768;
  }

  return 131072;
}

export function inferMaxOutputTokens(id: string): number {
  if (id.startsWith('deepseek-v4-')) {
    return 384000;
  }
  if (
    id.startsWith('devstral-') ||
    id.startsWith('kimi-') ||
    id.startsWith('mistral-large-')
  ) {
    return 262144;
  }
  if (id.startsWith('deepseek-v3.1')) {
    return 163840;
  }
  if (id.startsWith('gemma3:')) {
    return 131072;
  }
  if (
    id.startsWith('gemma4:') ||
    id.startsWith('glm-') ||
    id.startsWith('minimax-') ||
    id.startsWith('qwen3-vl:235b-instruct') ||
    id.startsWith('nemotron-3-nano') ||
    id.startsWith('nemotron-3-ultra')
  ) {
    return 131072;
  }
  if (id.startsWith('qwen3.5:397b')) {
    return 81920;
  }
  if (
    id.startsWith('deepseek-') ||
    id.startsWith('gpt-oss') ||
    id.startsWith('qwen3-next') ||
    id.startsWith('qwen3-vl:235b') ||
    id.startsWith('nemotron-3-super') ||
    id.startsWith('gemini-')
  ) {
    return 65536;
  }
  if (id.startsWith('qwen3-coder') || id.startsWith('cogito-')) {
    return 32768;
  }
  if (id.startsWith('rnj-')) {
    return 4096;
  }

  return 32768;
}

export function inferImageInput(id: string): boolean {
  return (
    id.includes('-vl:') ||
    id.startsWith('gemma3:') ||
    id.startsWith('gemma4:') ||
    id.startsWith('kimi-k2.5') ||
    id.startsWith('kimi-k2.6') ||
    id.startsWith('kimi-k2.7') ||
    id.startsWith('minimax-m3') ||
    id.startsWith('ministral-') ||
    id.startsWith('mistral-large-') ||
    id.startsWith('devstral-small-2')
  );
}

/**
 * Vision markers — multimodal model families that are image-capable
 * even when the model id does not match the `inferImageInput` prefix
 * rules (the family-marker fallback when provider metadata omits
 * `vision`).
 *
 * Covers: bakllava, gemma3, kimi-k2.6, llava, minicpm-v, moondream,
 * pixtral, qwen-vl, qwen2-vl, qwen2.5-vl, qwen2.5vl, vision, vlm.
 */
const VISION_MARKERS: readonly string[] = [
  'bakllava',
  'gemma3',
  'kimi-k2.6',
  'llava',
  'minicpm-v',
  'moondream',
  'pixtral',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5vl',
  'qwen2.5-vl',
  'vision',
  'vlm',
];

/**
 * Infers vision support from a model id + optional family name. Used
 * when the catalog does not have explicit `imageInput` metadata —
 * the family markers catch known multimodal models. Returns true when
 * any marker appears (case-insensitive) in the id or family.
 */
export function inferVisionSupport(id: string, family?: string): boolean {
  const value = `${id} ${family ?? ''}`.toLowerCase();
  return VISION_MARKERS.some((marker) => value.includes(marker));
}

/**
 * Returns true when `id` matches any wildcard pattern in `patterns`.
 * Patterns support `*` as a wildcard (matches any sequence, including
 * empty). Matching is case-insensitive. An empty pattern matches
 * nothing; `*` matches everything; `kimi-k2.6*` matches `kimi-k2.6`
 * and `kimi-k2.6:cloud`.
 */
export function matchesConfiguredVisionModel(
  id: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => matchesModelWildcard(id, pattern));
}

function matchesModelWildcard(id: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  // Anchor the pattern at both ends; `*` becomes `.*`. Escape all regex
  // specials EXCEPT `*` first, so the wildcard substitution can still
  // find the literal `*` character. (Escaping `*` to `\*` before the
  // substitution leaves a stray backslash and breaks wildcard matches.)
  const escaped = trimmed
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`, 'i');
  return re.test(id);
}

/**
 * Resolves a model's vision support — combines the snapshot metadata
 * (`imageInput`), the family-marker inference (`inferVisionSupport`),
 * and the user's manual `visionModels` patterns. This is the single
 * decision point for "does this model accept images?".
 *
 * The `connectionVisionPatterns` parameter is the per-connection
 * `visionModels` override (or the global list). Pass an empty array
 * to skip the manual-pattern check.
 */
export function resolveVisionSupport(
  model: Pick<ModelDefinition, 'apiModel' | 'family' | 'capabilities'>,
  connectionVisionPatterns: readonly string[],
): boolean {
  if (model.capabilities.imageInput) {
    return true;
  }
  if (inferVisionSupport(model.apiModel, model.family)) {
    return true;
  }
  if (matchesConfiguredVisionModel(model.apiModel, connectionVisionPatterns)) {
    return true;
  }
  return false;
}

export function inferToolCalling(id: string): boolean {
  if (id.startsWith('gemma3:')) {
    return false;
  }

  return true;
}

export function inferReasoning(id: string): boolean {
  // DeepSeek: v4 and v3.1 support thinking, v3.2 does not
  if (id.startsWith('deepseek-v4-') || id.startsWith('deepseek-v3.1')) {
    return true;
  }

  // Gemma 4 supports thinking
  if (id.startsWith('gemma4:')) {
    return true;
  }

  // MiniMax: m2 series supports thinking
  if (id.startsWith('minimax-m')) {
    return true;
  }

  // Gemini 3 Flash supports thinking
  if (id.startsWith('gemini-3-flash-preview')) {
    return true;
  }

  // GLM: all versions support thinking
  if (id.startsWith('glm-')) {
    return true;
  }

  // Kimi: k2.5, k2.6, and k2-thinking support thinking
  if (
    id.startsWith('kimi-k2.5') ||
    id.startsWith('kimi-k2.6') ||
    id.startsWith('kimi-k2.7') ||
    id.startsWith('kimi-k2-thinking')
  ) {
    return true;
  }

  // Qwen: 3.5, 3-next, 3-coder, 3-vl support thinking
  if (
    id.startsWith('qwen3.5:') ||
    id.startsWith('qwen3-next:') ||
    id.startsWith('qwen3-coder') ||
    id.startsWith('qwen3-vl:')
  ) {
    return true;
  }

  // GPT-OSS supports thinking with low/medium/high levels
  if (id.startsWith('gpt-oss')) {
    return true;
  }

  // Nemotron 3, Ministral support thinking
  if (
    id.startsWith('nemotron-3') ||
    id.startsWith('ministral-')
  ) {
    return true;
  }

  // Any model explicitly tagged as thinking
  if (id.includes('-thinking')) {
    return true;
  }

  return false;
}
