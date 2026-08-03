import * as vscode from 'vscode';
import type { ModelDefinition } from './modelCatalog.js';

// Phase 1 (2026-08-03 endpoint routing) — the wire format the
// resolved configuration targets. `'compat'` (default) keeps the
// existing vendor-extension thinking fields (`thinking: {type}`,
// `reasoning_effort`); `'native'` emits the Ollama-native top-level
// `think` field (`true | 'high' | 'medium' | 'low' | 'max'`).
export type EndpointFormat = 'compat' | 'native';

// DeepSeek V4 supports reasoning_effort with levels high/max only.
// Low and medium are mapped to high by the API. Off disables thinking.
const DEEPSEEK_V4_SCHEMA = {
  properties: {
    reasoningEffort: {
      type: 'string',
      title: 'Thinking',
      enum: ['none', 'high', 'max'],
      enumItemLabels: ['Off', 'High', 'Max'],
      default: 'high',
      group: 'navigation',
    },
  },
} as const;

// GLM, Kimi, Gemma, Nemotron, Minstral use simple on/off thinking toggle.
const BOOLEAN_THINKING_SCHEMA = {
  properties: {
    thinkingMode: {
      type: 'string',
      title: 'Thinking',
      enum: ['enabled', 'disabled'],
      enumItemLabels: ['On', 'Off'],
      default: 'enabled',
      group: 'navigation',
    },
  },
} as const;

// Qwen models support reasoning_effort with all levels (none/low/medium/high).
const QWEN_SCHEMA = {
  properties: {
    reasoningEffort: {
      type: 'string',
      title: 'Thinking',
      enum: ['none', 'low', 'medium', 'high'],
      enumItemLabels: ['Off', 'Low', 'Medium', 'High'],
      default: 'high',
      group: 'navigation',
    },
  },
} as const;

// GPT-OSS uses think levels (low/medium/high) and cannot be fully disabled.
const GPT_OSS_SCHEMA = {
  properties: {
    thinkLevel: {
      type: 'string',
      title: 'Thinking',
      enum: ['low', 'medium', 'high'],
      enumItemLabels: ['Low', 'Medium', 'High'],
      default: 'medium',
      group: 'navigation',
    },
  },
} as const;

export type ModelConfigurationSchema =
  | typeof DEEPSEEK_V4_SCHEMA
  | typeof BOOLEAN_THINKING_SCHEMA
  | typeof QWEN_SCHEMA
  | typeof GPT_OSS_SCHEMA;

export type ModelConfigurationOptions =
  vscode.ProvideLanguageModelChatResponseOptions & {
    readonly modelConfiguration?: Record<string, unknown>;
    readonly configuration?: Record<string, unknown>;
  };

export interface ResolvedModelRequestConfiguration {
  readonly openaiBody?: Record<string, unknown>;
}

function isDeepSeekV4(apiModel: string): boolean {
  return apiModel.startsWith('deepseek-v4-');
}

export function getModelConfigurationSchema(
  model: ModelDefinition,
): ModelConfigurationSchema | undefined {
  if (!model.reasoning) {
    return undefined;
  }

  // DeepSeek: V4 uses effort levels, v3.1 uses boolean toggle
  if (model.family === 'deepseek') {
    return isDeepSeekV4(model.apiModel)
      ? DEEPSEEK_V4_SCHEMA
      : BOOLEAN_THINKING_SCHEMA;
  }

  switch (model.family) {
    case 'glm':
    case 'kimi':
    case 'gemma':
    case 'nemotron':
    case 'ministral':
      return BOOLEAN_THINKING_SCHEMA;
    case 'qwen':
    case 'gemini':
      return QWEN_SCHEMA;
    case 'gpt-oss':
      return GPT_OSS_SCHEMA;
    default:
      return undefined;
  }
}

export function resolveModelRequestConfiguration(
  model: ModelDefinition,
  options: ModelConfigurationOptions,
  endpointFormat: EndpointFormat = 'compat',
): ResolvedModelRequestConfiguration {
  if (!model.reasoning) {
    return {};
  }

  // DeepSeek V4 sends reasoning_effort + thinking wrapper (compat) or
  // native `think` levels (native).
  if (model.family === 'deepseek' && isDeepSeekV4(model.apiModel)) {
    return resolveDeepSeekV4(options, endpointFormat);
  }

  // DeepSeek v3.1 sends think boolean
  if (model.family === 'deepseek') {
    return resolveDeepSeekV3_1(options, endpointFormat);
  }

  switch (model.family) {
    case 'glm':
      return resolveGlm(options, endpointFormat);
    case 'kimi':
    case 'gemma':
      return resolveKimi(options, endpointFormat);
    case 'qwen':
    case 'gemini':
      return resolveQwen(options, endpointFormat);
    case 'gpt-oss':
      return resolveGptOss(options, endpointFormat);
    case 'cogito':
    case 'nemotron':
    case 'ministral':
    case 'minimax':
      return resolveBooleanThink(options, endpointFormat);
    default:
      return {};
  }
}

// DeepSeek V4: reasoning_effort (none/high/max) with thinking type
// (compat) OR native `think` levels (none→false, high→'high', max→'max').
function resolveDeepSeekV4(
  options: ModelConfigurationOptions,
  endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const effort = readStringOption(options, 'reasoningEffort');
  if (endpointFormat === 'native') {
    // Native `/api/chat` top-level `think` field. DeepSeek V4 levels
    // map: none → false (disable), high → 'high', max → 'max'. The
    // native field accepts boolean | 'low' | 'medium' | 'high' | 'max'.
    if (effort === 'none') {
      return { openaiBody: { think: false } };
    }
    return { openaiBody: { think: effort === 'max' ? 'max' : 'high' } };
  }
  if (effort === 'none') {
    return {
      openaiBody: {
        thinking: { type: 'disabled' },
      },
    };
  }

  return {
    openaiBody: {
      thinking: { type: 'enabled' },
      reasoning_effort: effort === 'max' ? 'max' : 'high',
    },
  };
}

// DeepSeek v3.1: think boolean (same field name for compat and native;
// native accepts the boolean form identically — no change needed).
function resolveDeepSeekV3_1(
  options: ModelConfigurationOptions,
  _endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
  return {
    openaiBody: {
      think: mode !== 'disabled',
    },
  };
}

// GLM: thinking.type + clear_thinking (compat) OR native `think` (true
// when enabled, false when disabled — native does not support
// clear_thinking; the field is dropped on the native path).
function resolveGlm(
  options: ModelConfigurationOptions,
  endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
  if (endpointFormat === 'native') {
    return { openaiBody: { think: mode !== 'disabled' } };
  }
  if (mode === 'disabled') {
    return {
      openaiBody: {
        thinking: { type: 'disabled' },
      },
    };
  }

  return {
    openaiBody: {
      thinking: { type: 'enabled', clear_thinking: false },
    },
  };
}

// Kimi: thinking.type on/off (compat) OR native `think` boolean (native).
function resolveKimi(
  options: ModelConfigurationOptions,
  endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
  if (endpointFormat === 'native') {
    return { openaiBody: { think: mode !== 'disabled' } };
  }
  return {
    openaiBody: {
      thinking: {
        type: mode === 'disabled' ? 'disabled' : 'enabled',
      },
    },
  };
}

// Qwen: reasoning_effort (none/low/medium/high) (compat) OR native `think`
// levels (none → false, low → 'low', medium → 'medium', high → 'high').
function resolveQwen(
  options: ModelConfigurationOptions,
  endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const effort = readStringOption(options, 'reasoningEffort');
  if (endpointFormat === 'native') {
    if (!effort || effort === 'none') {
      return { openaiBody: { think: false } };
    }
    return { openaiBody: { think: effort } };
  }
  if (!effort || effort === 'none') {
    return {
      openaiBody: { reasoning_effort: 'none' },
    };
  }

  return {
    openaiBody: { reasoning_effort: effort },
  };
}

// GPT-OSS: think level (low/medium/high, cannot disable)
//
// The `think` field name is identical in native `/api/chat` and the
// compat vendor extension, so the body does not branch on endpointFormat;
// the parameter exists to satisfy the per-family resolver call site.
function resolveGptOss(
  options: ModelConfigurationOptions,
  _endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const level = readStringOption(options, 'thinkLevel');
  return {
    openaiBody: { think: level ?? 'medium' },
  };
}

// Cogito, Nemotron, Ministral, MiniMax: think boolean.
// Native `/api/chat` emits a top-level `think` boolean; the compat path
// emits the structured `thinking: { type: 'enabled' | 'disabled' }` body.
function resolveBooleanThink(
  options: ModelConfigurationOptions,
  endpointFormat: EndpointFormat,
): ResolvedModelRequestConfiguration {
  const enabled = readStringOption(options, 'thinkingMode') !== 'disabled';
  if (endpointFormat === 'native') {
    return { openaiBody: { think: enabled } };
  }
  return {
    openaiBody: { thinking: { type: enabled ? 'enabled' : 'disabled' } },
  };
}

function readStringOption(
  options: ModelConfigurationOptions,
  key: string,
): string | undefined {
  const modelValue = options.modelConfiguration?.[key];
  if (typeof modelValue === 'string' && modelValue.trim()) {
    return modelValue.trim();
  }

  const legacyValue = options.configuration?.[key];
  if (typeof legacyValue === 'string' && legacyValue.trim()) {
    return legacyValue.trim();
  }

  return undefined;
}
