import { strict as assert } from 'node:assert';
import {
  getModelConfigurationSchema,
  resolveModelRequestConfiguration,
  type ModelConfigurationOptions,
} from '../../src/modelConfiguration.js';
import type { ModelDefinition } from '../../src/modelCatalog.js';

/**
 * Builds a minimal ModelDefinition for a given family + apiModel.
 * The resolver only reads `family`, `apiModel`, and `reasoning`, so
 * the rest of the fields are populated with neutral defaults.
 */
function makeModel(
  family: string,
  apiModel: string,
  reasoning = true,
): ModelDefinition {
  return {
    id: `ollama-cloud/${apiModel}`,
    apiModel,
    name: apiModel,
    family,
    version: 'test',
    detail: 'test',
    connectionId: 'cloud',
    origin: 'Cloud',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    reasoning,
    capabilities: { imageInput: false, toolCalling: true },
  };
}

/**
 * Builds ModelConfigurationOptions from a modelConfiguration record.
 * The legacy `configuration` field is exercised separately by
 * individual tests.
 */
function makeOptions(
  modelConfiguration?: Record<string, unknown>,
  configuration?: Record<string, unknown>,
): ModelConfigurationOptions {
  return {
    modelOptions: {},
    justification: 'test',
    modelConfiguration,
    configuration,
  } as unknown as ModelConfigurationOptions;
}

describe('modelConfiguration.resolveModelRequestConfiguration', () => {
  describe('DeepSeek V4 family', () => {
    it('emits disabled thinking when reasoningEffort=none', () => {
      const model = makeModel('deepseek', 'deepseek-v4-pro');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 'none' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'disabled' },
      });
    });

    it('emits enabled thinking + reasoning_effort=high by default', () => {
      const model = makeModel('deepseek', 'deepseek-v4-pro');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 'high' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      });
    });

    it('emits reasoning_effort=max when effort=max', () => {
      const model = makeModel('deepseek', 'deepseek-v4-pro');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 'max' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
      });
    });

    it('treats unknown effort as high (falls through to else branch)', () => {
      const model = makeModel('deepseek', 'deepseek-v4-pro');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 'bogus' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      });
    });
  });

  describe('DeepSeek v3.1 family', () => {
    it('emits think=true when thinkingMode=enabled', () => {
      const model = makeModel('deepseek', 'deepseek-v3.1:671b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'enabled' }),
      );
      assert.deepEqual(result.openaiBody, { think: true });
    });

    it('emits think=false when thinkingMode=disabled', () => {
      const model = makeModel('deepseek', 'deepseek-v3.1:671b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'disabled' }),
      );
      assert.deepEqual(result.openaiBody, { think: false });
    });

    it('defaults to think=true when no option supplied', () => {
      const model = makeModel('deepseek', 'deepseek-v3.1:671b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions(),
      );
      assert.deepEqual(result.openaiBody, { think: true });
    });
  });

  describe('GLM family', () => {
    it('emits disabled thinking when thinkingMode=disabled', () => {
      const model = makeModel('glm', 'glm-5.2');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'disabled' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'disabled' },
      });
    });

    it('emits enabled thinking with clear_thinking=false when enabled', () => {
      const model = makeModel('glm', 'glm-5.2');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'enabled' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'enabled', clear_thinking: false },
      });
    });
  });

  describe('Kimi family', () => {
    it('emits enabled thinking when thinkingMode=enabled', () => {
      const model = makeModel('kimi', 'kimi-k2.6');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'enabled' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'enabled' },
      });
    });

    it('emits disabled thinking when thinkingMode=disabled', () => {
      const model = makeModel('kimi', 'kimi-k2.6');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'disabled' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'disabled' },
      });
    });
  });

  describe('Qwen family', () => {
    it('emits reasoning_effort=none when effort=none', () => {
      const model = makeModel('qwen', 'qwen3-vl:235b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 'none' }),
      );
      assert.deepEqual(result.openaiBody, { reasoning_effort: 'none' });
    });

    it('emits reasoning_effort=medium when effort=medium', () => {
      const model = makeModel('qwen', 'qwen3-vl:235b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 'medium' }),
      );
      assert.deepEqual(result.openaiBody, { reasoning_effort: 'medium' });
    });

    it('defaults to reasoning_effort=none when no option supplied', () => {
      const model = makeModel('qwen', 'qwen3-vl:235b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions(),
      );
      assert.deepEqual(result.openaiBody, { reasoning_effort: 'none' });
    });
  });

  describe('GPT-OSS family', () => {
    it('emits think=high when thinkLevel=high', () => {
      const model = makeModel('gpt-oss', 'gpt-oss:120b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkLevel: 'high' }),
      );
      assert.deepEqual(result.openaiBody, { think: 'high' });
    });

    it('defaults to think=medium when no option supplied', () => {
      const model = makeModel('gpt-oss', 'gpt-oss:120b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions(),
      );
      assert.deepEqual(result.openaiBody, { think: 'medium' });
    });
  });

  describe('Boolean-think families (cogito / nemotron / ministral / minimax)', () => {
    it('cogito emits think=true when enabled', () => {
      const model = makeModel('cogito', 'cogito-2.1:671b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'enabled' }),
      );
      assert.deepEqual(result.openaiBody, { think: true });
    });

    it('nemotron emits think=false when disabled', () => {
      const model = makeModel('nemotron', 'nemotron-3-ultra');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'disabled' }),
      );
      assert.deepEqual(result.openaiBody, { think: false });
    });

    it('ministral defaults to think=true', () => {
      const model = makeModel('ministral', 'ministral-3:14b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions(),
      );
      assert.deepEqual(result.openaiBody, { think: true });
    });

    it('minimax emits think=false when disabled', () => {
      const model = makeModel('minimax', 'minimax-m3');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'disabled' }),
      );
      assert.deepEqual(result.openaiBody, { think: false });
    });
  });

  describe('Edge cases', () => {
    it('returns empty body when model is non-reasoning', () => {
      const model = makeModel('gemma', 'gemma3:12b', false);
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'enabled' }),
      );
      assert.deepEqual(result, {});
    });

    it('returns empty body for unknown family', () => {
      const model = makeModel('unknown-family', 'weird-model');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ thinkingMode: 'enabled' }),
      );
      assert.deepEqual(result, {});
    });

    it('reads legacy configuration field when modelConfiguration missing', () => {
      const model = makeModel('glm', 'glm-5.2');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions(undefined, { thinkingMode: 'disabled' }),
      );
      assert.deepEqual(result.openaiBody, {
        thinking: { type: 'disabled' },
      });
    });

    it('trims whitespace in option values', () => {
      const model = makeModel('qwen', 'qwen3-vl:235b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: '  medium  ' }),
      );
      assert.deepEqual(result.openaiBody, { reasoning_effort: 'medium' });
    });

    it('ignores non-string option values', () => {
      const model = makeModel('qwen', 'qwen3-vl:235b');
      const result = resolveModelRequestConfiguration(
        model,
        makeOptions({ reasoningEffort: 42 }),
      );
      // Non-string → falls through to undefined → defaults to 'none'
      assert.deepEqual(result.openaiBody, { reasoning_effort: 'none' });
    });
  });
});

describe('modelConfiguration.getModelConfigurationSchema', () => {
  it('returns undefined for non-reasoning model', () => {
    const model = makeModel('gemma', 'gemma3:12b', false);
    assert.equal(getModelConfigurationSchema(model), undefined);
  });

  it('returns DeepSeek V4 schema for deepseek-v4-* models', () => {
    const model = makeModel('deepseek', 'deepseek-v4-pro');
    const schema = getModelConfigurationSchema(model);
    assert.ok(schema);
    assert.ok('reasoningEffort' in schema!.properties, 'deepseek-v4 schema has reasoningEffort'); assert.equal((schema!.properties as any).reasoningEffort.enum[0], 'none');
  });

  it('returns boolean thinking schema for deepseek v3.1', () => {
    const model = makeModel('deepseek', 'deepseek-v3.1:671b');
    const schema = getModelConfigurationSchema(model);
    assert.ok(schema);
    assert.ok('thinkingMode' in schema!.properties);
  });

  it('returns QWEN schema for qwen family', () => {
    const model = makeModel('qwen', 'qwen3-vl:235b');
    const schema = getModelConfigurationSchema(model);
    assert.ok(schema);
    assert.ok('reasoningEffort' in schema!.properties);
  });

  it('returns GPT-OSS schema for gpt-oss family', () => {
    const model = makeModel('gpt-oss', 'gpt-oss:120b');
    const schema = getModelConfigurationSchema(model);
    assert.ok(schema);
    assert.ok('thinkLevel' in schema!.properties);
  });

  it('returns boolean thinking schema for glm/kimi/gemma/nemotron/ministral', () => {
    for (const family of ['glm', 'kimi', 'gemma', 'nemotron', 'ministral']) {
      const model = makeModel(family, `${family}-test-model`);
      const schema = getModelConfigurationSchema(model);
      assert.ok(schema, `schema should be defined for ${family}`);
      assert.ok('thinkingMode' in schema!.properties);
    }
  });

  it('returns undefined for unknown family', () => {
    const model = makeModel('totally-unknown', 'weird-model');
    assert.equal(getModelConfigurationSchema(model), undefined);
  });
});