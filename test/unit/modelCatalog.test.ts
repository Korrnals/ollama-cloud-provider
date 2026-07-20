import { strict as assert } from 'node:assert';
import {
  humanizeModelId,
  inferFamily,
  inferVersion,
  inferMaxInputTokens,
  inferMaxOutputTokens,
  inferReasoning,
  inferImageInput,
  inferToolCalling,
} from '../../src/modelCatalog.js';

describe('modelCatalog.inferFamily', () => {
  it('returns cogito for cogito-*', () => {
    assert.equal(inferFamily('cogito-2.1:671b'), 'cogito');
  });

  it('returns deepseek for deepseek-*', () => {
    assert.equal(inferFamily('deepseek-v3.1:671b'), 'deepseek');
    assert.equal(inferFamily('deepseek-v4-pro'), 'deepseek');
  });

  it('returns devstral for devstral* (no leading dash)', () => {
    assert.equal(inferFamily('devstral-2:123b'), 'devstral');
  });

  it('returns gemini for gemini-*', () => {
    assert.equal(inferFamily('gemini-3-flash-preview'), 'gemini');
  });

  it('returns gemma for gemma* (no leading dash)', () => {
    assert.equal(inferFamily('gemma3:12b'), 'gemma');
    assert.equal(inferFamily('gemma4:31b'), 'gemma');
  });

  it('returns glm for glm-*', () => {
    assert.equal(inferFamily('glm-5.2'), 'glm');
  });

  it('returns gpt-oss for gpt-oss* (no leading dash)', () => {
    assert.equal(inferFamily('gpt-oss:120b'), 'gpt-oss');
  });

  it('returns kimi for kimi-*', () => {
    assert.equal(inferFamily('kimi-k2.6'), 'kimi');
  });

  it('returns minimax for minimax-*', () => {
    assert.equal(inferFamily('minimax-m3'), 'minimax');
  });

  it('returns ministral for ministral-*', () => {
    assert.equal(inferFamily('ministral-3:14b'), 'ministral');
  });

  it('returns mistral for mistral-*', () => {
    assert.equal(inferFamily('mistral-large-3:675b'), 'mistral');
  });

  it('returns nemotron for nemotron-*', () => {
    assert.equal(inferFamily('nemotron-3-ultra'), 'nemotron');
  });

  it('returns qwen for qwen* (no leading dash)', () => {
    assert.equal(inferFamily('qwen3-vl:235b'), 'qwen');
    assert.equal(inferFamily('qwen3.5:397b'), 'qwen');
  });

  it('returns rnj for rnj-*', () => {
    assert.equal(inferFamily('rnj-1:8b'), 'rnj');
  });

  it('returns ollama-cloud for unknown families', () => {
    assert.equal(inferFamily('something-weird'), 'ollama-cloud');
  });

  it('returns ollama-cloud for empty string', () => {
    assert.equal(inferFamily(''), 'ollama-cloud');
  });

  it('returns ollama-cloud for partial match', () => {
    // 'deepseek' alone doesn't match 'deepseek-' prefix
    assert.equal(inferFamily('deepseek'), 'ollama-cloud');
  });
});

describe('modelCatalog.inferVersion', () => {
  it('strips family- prefix for dash-joined families', () => {
    assert.equal(inferVersion('glm-5.2', 'glm'), '5.2');
    assert.equal(inferVersion('deepseek-v4-pro', 'deepseek'), 'v4-pro');
  });

  it('strips family: prefix for colon-joined families', () => {
    assert.equal(inferVersion('ministral-3:14b', 'ministral'), '3:14b');
  });

  it('strips family without separator for gemma', () => {
    assert.equal(inferVersion('gemma3:12b', 'gemma'), '3:12b');
  });

  it('strips family without separator for qwen', () => {
    assert.equal(inferVersion('qwen3-vl:235b', 'qwen'), '3-vl:235b');
  });

  it('strips family without separator for gpt-oss', () => {
    assert.equal(inferVersion('gpt-oss:120b', 'gpt-oss'), '120b');
  });

  it('returns id unchanged when no family prefix matches', () => {
    assert.equal(inferVersion('weird-model', 'unknown'), 'weird-model');
  });
});

describe('modelCatalog.inferMaxInputTokens', () => {
  it('returns 1048576 for deepseek-v4-*', () => {
    assert.equal(inferMaxInputTokens('deepseek-v4-pro'), 1048576);
  });

  it('returns 1048576 for gemini-3-flash-preview', () => {
    assert.equal(inferMaxInputTokens('gemini-3-flash-preview'), 1048576);
  });

  it('returns 163840 for deepseek-v3.1 (non-V4)', () => {
    assert.equal(inferMaxInputTokens('deepseek-v3.1:671b'), 163840);
  });

  it('returns 262144 for kimi-*', () => {
    assert.equal(inferMaxInputTokens('kimi-k2.6'), 262144);
  });

  it('returns 1000000 for glm-5.2', () => {
    assert.equal(inferMaxInputTokens('glm-5.2'), 1000000);
  });

  it('returns 202752 for glm-* (non-5.2)', () => {
    assert.equal(inferMaxInputTokens('glm-4.6'), 202752);
  });

  it('returns 524288 for minimax-m3*', () => {
    assert.equal(inferMaxInputTokens('minimax-m3'), 524288);
  });

  it('returns 204800 for minimax-* (non-m3)', () => {
    assert.equal(inferMaxInputTokens('minimax-m2'), 204800);
  });

  it('returns 131072 for gpt-oss*', () => {
    assert.equal(inferMaxInputTokens('gpt-oss:120b'), 131072);
  });

  it('returns 262144 for gemma4:*', () => {
    assert.equal(inferMaxInputTokens('gemma4:31b'), 262144);
  });

  it('returns 131072 for gemma3:*', () => {
    assert.equal(inferMaxInputTokens('gemma3:12b'), 131072);
  });

  it('returns 32768 for rnj-*', () => {
    assert.equal(inferMaxInputTokens('rnj-1:8b'), 32768);
  });

  it('defaults to 131072 for unknown ids', () => {
    assert.equal(inferMaxInputTokens('totally-unknown-model'), 131072);
    assert.equal(inferMaxInputTokens(''), 131072);
  });
});

describe('modelCatalog.inferMaxOutputTokens', () => {
  it('returns 384000 for deepseek-v4-*', () => {
    assert.equal(inferMaxOutputTokens('deepseek-v4-pro'), 384000);
  });

  it('returns 163840 for deepseek-v3.1', () => {
    assert.equal(inferMaxOutputTokens('deepseek-v3.1:671b'), 163840);
  });

  it('returns 262144 for devstral-*', () => {
    assert.equal(inferMaxOutputTokens('devstral-2:123b'), 262144);
  });

  it('returns 262144 for kimi-*', () => {
    assert.equal(inferMaxOutputTokens('kimi-k2.6'), 262144);
  });

  it('returns 131072 for glm-*', () => {
    assert.equal(inferMaxOutputTokens('glm-5.2'), 131072);
  });

  it('returns 81920 for qwen3.5:397b', () => {
    assert.equal(inferMaxOutputTokens('qwen3.5:397b'), 81920);
  });

  it('returns 65536 for gpt-oss', () => {
    assert.equal(inferMaxOutputTokens('gpt-oss:120b'), 65536);
  });

  it('returns 32768 for cogito-*', () => {
    assert.equal(inferMaxOutputTokens('cogito-2.1:671b'), 32768);
  });

  it('returns 4096 for rnj-*', () => {
    assert.equal(inferMaxOutputTokens('rnj-1:8b'), 4096);
  });

  it('defaults to 32768 for unknown ids', () => {
    assert.equal(inferMaxOutputTokens('totally-unknown-model'), 32768);
    assert.equal(inferMaxOutputTokens(''), 32768);
  });
});

describe('modelCatalog.inferReasoning', () => {
  it('returns true for deepseek-v4-*', () => {
    assert.equal(inferReasoning('deepseek-v4-pro'), true);
  });

  it('returns true for deepseek-v3.1', () => {
    assert.equal(inferReasoning('deepseek-v3.1:671b'), true);
  });

  it('returns false for deepseek-v3.2', () => {
    assert.equal(inferReasoning('deepseek-v3.2'), false);
  });

  it('returns true for gemma4:*', () => {
    assert.equal(inferReasoning('gemma4:31b'), true);
  });

  it('returns false for gemma3:* (no reasoning)', () => {
    assert.equal(inferReasoning('gemma3:12b'), false);
  });

  it('returns true for minimax-m* series', () => {
    assert.equal(inferReasoning('minimax-m3'), true);
    assert.equal(inferReasoning('minimax-m2'), true);
  });

  it('returns true for gemini-3-flash-preview', () => {
    assert.equal(inferReasoning('gemini-3-flash-preview'), true);
  });

  it('returns true for all glm-*', () => {
    assert.equal(inferReasoning('glm-4.6'), true);
    assert.equal(inferReasoning('glm-5.2'), true);
  });

  it('returns true for kimi-k2.5/2.6/2.7 and kimi-k2-thinking', () => {
    assert.equal(inferReasoning('kimi-k2.5'), true);
    assert.equal(inferReasoning('kimi-k2.6'), true);
    assert.equal(inferReasoning('kimi-k2.7-code'), true);
    assert.equal(inferReasoning('kimi-k2-thinking'), true);
  });

  it('returns false for kimi-k2:1t (not in thinking list)', () => {
    assert.equal(inferReasoning('kimi-k2:1t'), false);
  });

  it('returns true for qwen3.5/3-next/3-coder/3-vl', () => {
    assert.equal(inferReasoning('qwen3.5:397b'), true);
    assert.equal(inferReasoning('qwen3-next:80b'), true);
    assert.equal(inferReasoning('qwen3-coder:480b'), true);
    assert.equal(inferReasoning('qwen3-vl:235b'), true);
  });

  it('returns true for gpt-oss*', () => {
    assert.equal(inferReasoning('gpt-oss:120b'), true);
  });

  it('returns true for nemotron-3-*', () => {
    assert.equal(inferReasoning('nemotron-3-ultra'), true);
    assert.equal(inferReasoning('nemotron-3-super'), true);
    assert.equal(inferReasoning('nemotron-3-nano:30b'), true);
  });

  it('returns true for ministral-*', () => {
    assert.equal(inferReasoning('ministral-3:14b'), true);
  });

  it('returns true for any id containing -thinking', () => {
    assert.equal(inferReasoning('totally-new-thinking-model'), true);
  });

  it('returns false for unknown non-thinking ids', () => {
    assert.equal(inferReasoning('totally-unknown-model'), false);
    assert.equal(inferReasoning(''), false);
  });
});

describe('modelCatalog.inferImageInput', () => {
  it('returns true for -vl: ids', () => {
    assert.equal(inferImageInput('qwen3-vl:235b'), true);
  });

  it('returns true for gemma3:*', () => {
    assert.equal(inferImageInput('gemma3:12b'), true);
  });

  it('returns true for gemma4:*', () => {
    assert.equal(inferImageInput('gemma4:31b'), true);
  });

  it('returns true for kimi-k2.5/2.6/2.7', () => {
    assert.equal(inferImageInput('kimi-k2.5'), true);
    assert.equal(inferImageInput('kimi-k2.6'), true);
    assert.equal(inferImageInput('kimi-k2.7-code'), true);
  });

  it('returns false for kimi-k2:1t (not in vision list)', () => {
    assert.equal(inferImageInput('kimi-k2:1t'), false);
  });

  it('returns true for minimax-m3', () => {
    assert.equal(inferImageInput('minimax-m3'), true);
  });

  it('returns true for ministral-*', () => {
    assert.equal(inferImageInput('ministral-3:14b'), true);
  });

  it('returns true for mistral-large-*', () => {
    assert.equal(inferImageInput('mistral-large-3:675b'), true);
  });

  it('returns true for devstral-small-2', () => {
    assert.equal(inferImageInput('devstral-small-2:24b'), true);
  });

  it('returns false for unknown ids', () => {
    assert.equal(inferImageInput('totally-unknown-model'), false);
    assert.equal(inferImageInput(''), false);
  });
});

describe('modelCatalog.inferToolCalling', () => {
  it('returns false for gemma3:*', () => {
    assert.equal(inferToolCalling('gemma3:12b'), false);
    assert.equal(inferToolCalling('gemma3:4b'), false);
    assert.equal(inferToolCalling('gemma3:27b'), false);
  });

  it('returns true for gemma4:* (only gemma3 is excluded)', () => {
    assert.equal(inferToolCalling('gemma4:31b'), true);
  });

  it('returns true for unknown ids (default)', () => {
    assert.equal(inferToolCalling('totally-unknown-model'), true);
    assert.equal(inferToolCalling(''), true);
  });
});

describe('modelCatalog.humanizeModelId', () => {
  it('humanizes glm-5.2 to "GLM 5.2"', () => {
    assert.equal(humanizeModelId('glm-5.2'), 'GLM 5.2');
  });

  it('humanizes deepseek-v4-pro to "DeepSeek V4 Pro"', () => {
    assert.equal(humanizeModelId('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  });

  it('humanizes gpt-oss:120b to "GPT OSS:120B"', () => {
    assert.equal(humanizeModelId('gpt-oss:120b'), 'GPT OSS:120B');
  });

  it('humanizes qwen3-vl:235b to "Qwen3 VL:235B"', () => {
    assert.equal(humanizeModelId('qwen3-vl:235b'), 'Qwen3 VL:235B');
  });

  it('humanizes kimi-k2-thinking to "Kimi K2 Thinking"', () => {
    assert.equal(humanizeModelId('kimi-k2-thinking'), 'Kimi K2 Thinking');
  });

  it('humanizes empty string to empty string', () => {
    assert.equal(humanizeModelId(''), '');
  });

  it('humanizes unknown segment by capitalizing first letter', () => {
    // 'weird' is not in HUMANIZED_SEGMENTS → capitalized
    assert.equal(humanizeModelId('weird-model'), 'Weird Model');
  });
});