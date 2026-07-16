import * as vscode from 'vscode';
import type { ModelDefinition } from './modelCatalog.js';

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
): ResolvedModelRequestConfiguration {
  if (!model.reasoning) {
    return {};
  }

  // DeepSeek V4 sends reasoning_effort + thinking wrapper
  if (model.family === 'deepseek' && isDeepSeekV4(model.apiModel)) {
    return resolveDeepSeekV4(options);
  }

  // DeepSeek v3.1 sends think boolean
  if (model.family === 'deepseek') {
    return resolveDeepSeekV3_1(options);
  }

  switch (model.family) {
    case 'glm':
      return resolveGlm(options);
    case 'kimi':
    case 'gemma':
      return resolveKimi(options);
    case 'qwen':
    case 'gemini':
      return resolveQwen(options);
    case 'gpt-oss':
      return resolveGptOss(options);
    case 'cogito':
    case 'nemotron':
    case 'ministral':
    case 'minimax':
      return resolveBooleanThink(options);
    default:
      return {};
  }
}

// DeepSeek V4: reasoning_effort (none/high/max) with thinking type
function resolveDeepSeekV4(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const effort = readStringOption(options, 'reasoningEffort');
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

// DeepSeek v3.1: think boolean
function resolveDeepSeekV3_1(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
  return {
    openaiBody: {
      think: mode !== 'disabled',
    },
  };
}

// GLM: thinking.type + clear_thinking
function resolveGlm(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
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

// Kimi: thinking.type on/off
function resolveKimi(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
  return {
    openaiBody: {
      thinking: {
        type: mode === 'disabled' ? 'disabled' : 'enabled',
      },
    },
  };
}

// Qwen: reasoning_effort (none/low/medium/high)
function resolveQwen(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const effort = readStringOption(options, 'reasoningEffort');
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
function resolveGptOss(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const level = readStringOption(options, 'thinkLevel');
  return {
    openaiBody: { think: level ?? 'medium' },
  };
}

// Cogito, Nemotron, Minstral: think boolean
function resolveBooleanThink(
  options: ModelConfigurationOptions,
): ResolvedModelRequestConfiguration {
  const mode = readStringOption(options, 'thinkingMode');
  return {
    openaiBody: { think: mode !== 'disabled' },
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
