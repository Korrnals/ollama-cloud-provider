import { AuthManager } from './auth.js';
import { logger } from './logger.js';

const MODELS_ENDPOINT_SUFFIX = '/models';
const TAGS_ENDPOINT_SUFFIX = '/api/tags';
const DEFAULT_DETAIL = 'Ollama Cloud';

export interface ModelDefinition {
  id: string;
  apiModel: string;
  name: string;
  family: string;
  version: string;
  detail: string;
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

  private async fetchModelIds(): Promise<string[]> {
    const apiKey = await this.authManager.getApiKey();
    const baseUrl = this.authManager.getBaseUrl();
    const rootUrl = this.authManager.getRootUrl();

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
    maxInputTokens: inferMaxInputTokens(id),
    maxOutputTokens: inferMaxOutputTokens(id),
    reasoning: inferReasoning(id),
    capabilities: {
      imageInput: inferImageInput(id),
      toolCalling: inferToolCalling(id),
    },
  };
}

async function fetchModelIdsFromOpenAICatalog(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const response = await fetch(`${baseUrl}${MODELS_ENDPOINT_SUFFIX}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `Model catalog request failed with HTTP ${response.status}.`,
    );
  }

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
  const response = await fetch(`${rootUrl}${TAGS_ENDPOINT_SUFFIX}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `Tags catalog request failed with HTTP ${response.status}.`,
    );
  }

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

function humanizeModelId(id: string): string {
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

function inferFamily(id: string): string {
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

function inferVersion(id: string, family: string): string {
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

function inferMaxInputTokens(id: string): number {
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

function inferMaxOutputTokens(id: string): number {
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

function inferImageInput(id: string): boolean {
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

function inferToolCalling(id: string): boolean {
  if (id.startsWith('gemma3:')) {
    return false;
  }

  return true;
}

function inferReasoning(id: string): boolean {
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
