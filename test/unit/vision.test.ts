import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  inferVisionSupport,
  matchesConfiguredVisionModel,
  resolveVisionSupport,
} from '../../src/modelCatalog.js';
import type { ModelDefinition } from '../../src/modelCatalog.js';
import {
  convertMessagesToOpenAI,
  hasImageParts,
  isImageDataPart,
  toDataUrl,
} from '../../src/convert.js';

/**
 * Vision + image-conversion tests — covers the `inferVisionSupport` /
 * `resolveVisionSupport` family-marker inference, the manual
 * `visionModels` wildcard patterns, and the `convert.ts` image-part
 * → `data:` URL conversion path.
 *
 * The provider-level vision gate (request has images + model does not
 * support images → throw) is exercised in the integration test file
 * `test/integration/provider.test.ts` to keep this unit file free of
 * `OllamaClient`/fetch wiring.
 */

const { LanguageModelDataPart, LanguageModelTextPart, LanguageModelChatMessageRole } =
  vscode;

/**
 * Builds a minimal ModelDefinition with the given vision capability.
 * `resolveVisionSupport` only reads `apiModel`, `family`, and
 * `capabilities.imageInput`, so the rest are neutral defaults.
 */
function makeModel(
  apiModel: string,
  family: string,
  imageInput: boolean,
): Pick<ModelDefinition, 'apiModel' | 'family' | 'capabilities'> {
  return {
    apiModel,
    family,
    capabilities: { imageInput, toolCalling: true },
  };
}

describe('vision.inferVisionSupport — family markers', () => {
  it('returns true for kimi-k2.6', () => {
    assert.equal(inferVisionSupport('kimi-k2.6'), true);
  });

  it('returns true for llava family', () => {
    assert.equal(inferVisionSupport('llava:13b'), true);
    assert.equal(inferVisionSupport('bakllava:7b'), true);
  });

  it('returns true for qwen2.5-vl', () => {
    assert.equal(inferVisionSupport('qwen2.5-vl:32b'), true);
    assert.equal(inferVisionSupport('qwen2.5vl:32b'), true);
    assert.equal(inferVisionSupport('qwen-vl:7b'), true);
  });

  it('returns true for gemma3', () => {
    assert.equal(inferVisionSupport('gemma3:12b'), true);
  });

  it('returns true for moondream', () => {
    assert.equal(inferVisionSupport('moondream:1.8b'), true);
  });

  it('returns true for pixtral', () => {
    assert.equal(inferVisionSupport('pixtral-12b'), true);
  });

  it('returns true for minicpm-v', () => {
    assert.equal(inferVisionSupport('minicpm-v:8b'), true);
  });

  it('returns true for the vlm marker', () => {
    assert.equal(inferVisionSupport('some-vlm-12b'), true);
  });

  it('matches via the family name when the id lacks a marker', () => {
    assert.equal(inferVisionSupport('custom-model', 'llava'), true);
  });

  it('returns false for a text-only model with no marker', () => {
    assert.equal(inferVisionSupport('gpt-oss:120b'), false);
    assert.equal(inferVisionSupport('deepseek-v3.1:671b'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(inferVisionSupport('LLAVA:13b'), true);
    assert.equal(inferVisionSupport('GEMMA3:12b'), true);
  });
});

describe('vision.matchesConfiguredVisionModel — manual patterns', () => {
  it('matches a wildcard prefix pattern', () => {
    assert.equal(
      matchesConfiguredVisionModel('my-vision:7b', ['my-vision:*']),
      true,
    );
  });

  it('matches a wildcard suffix pattern', () => {
    assert.equal(
      matchesConfiguredVisionModel('org-vision-7b', ['*-vision-*']),
      true,
    );
  });

  it('matches an exact id (no wildcard)', () => {
    assert.equal(
      matchesConfiguredVisionModel('llava:13b', ['llava:13b']),
      true,
    );
  });

  it('matches `*` (matches everything)', () => {
    assert.equal(
      matchesConfiguredVisionModel('any-model', ['*']),
      true,
    );
  });

  it('returns false when no pattern matches', () => {
    assert.equal(
      matchesConfiguredVisionModel('gpt-oss:120b', ['llava:*', 'qwen-vl:*']),
      false,
    );
  });

  it('ignores empty / whitespace-only patterns', () => {
    assert.equal(
      matchesConfiguredVisionModel('llava:13b', ['', '  ']),
      false,
    );
  });

  it('is case-insensitive', () => {
    assert.equal(
      matchesConfiguredVisionModel('MY-VISION:7B', ['my-vision:*']),
      true,
    );
  });

  it('returns false for an empty pattern list', () => {
    assert.equal(
      matchesConfiguredVisionModel('llava:13b', []),
      false,
    );
  });
});

describe('vision.resolveVisionSupport — combined decision', () => {
  it('returns true when capabilities.imageInput is set', () => {
    const model = makeModel('custom-thing', 'custom', true);
    assert.equal(resolveVisionSupport(model, []), true);
  });

  it('returns true via family-marker inference when metadata is false', () => {
    const model = makeModel('llava:13b', 'llava', false);
    assert.equal(resolveVisionSupport(model, []), true);
  });

  it('returns true via manual pattern when metadata + family both miss', () => {
    const model = makeModel('my-vision:7b', 'my-vision', false);
    assert.equal(resolveVisionSupport(model, ['my-vision:*']), true);
  });

  it('returns false when all three sources miss', () => {
    const model = makeModel('gpt-oss:120b', 'gpt-oss', false);
    assert.equal(resolveVisionSupport(model, ['llava:*']), false);
  });

  it('capabilities.imageInput short-circuits before pattern check', () => {
    // Even with no patterns, imageInput metadata wins.
    const model = makeModel('whatever', 'whatever', true);
    assert.equal(resolveVisionSupport(model, []), true);
  });

  it('family inference wins over a non-matching pattern list', () => {
    const model = makeModel('gemma3:12b', 'gemma', false);
    // Pattern list does not match gemma3, but family marker does.
    assert.equal(resolveVisionSupport(model, ['llava:*']), true);
  });
});

describe('convert.hasImageParts / isImageDataPart — image detection', () => {
  it('detects an image data part via the stub class', () => {
    const part = new LanguageModelDataPart(
      new Uint8Array([1, 2, 3]),
      'image/png',
    );
    assert.equal(isImageDataPart(part), true);
    assert.equal(hasImageParts([part]), true);
  });

  it('detects a duck-typed image part (mimeType + Uint8Array)', () => {
    const part = {
      mimeType: 'image/jpeg',
      data: new Uint8Array([1, 2, 3]),
    };
    assert.equal(isImageDataPart(part), true);
    assert.equal(hasImageParts([part]), true);
  });

  it('returns false for a text part', () => {
    const part = new LanguageModelTextPart('hello');
    assert.equal(isImageDataPart(part), false);
    assert.equal(hasImageParts([part]), false);
  });

  it('returns false for a non-image data part (e.g. audio)', () => {
    const part = new LanguageModelDataPart(
      new Uint8Array([1, 2, 3]),
      'audio/wav',
    );
    assert.equal(isImageDataPart(part), false);
    assert.equal(hasImageParts([part]), false);
  });

  it('returns false for null / undefined / primitives', () => {
    assert.equal(isImageDataPart(null), false);
    assert.equal(isImageDataPart(undefined), false);
    assert.equal(isImageDataPart('image/png'), false);
    assert.equal(isImageDataPart(42), false);
  });

  it('returns false for a duck-typed object missing data', () => {
    const part = { mimeType: 'image/png' };
    assert.equal(isImageDataPart(part), false);
  });

  it('detects images mixed with text parts', () => {
    const parts = [
      new LanguageModelTextPart('what is this?'),
      new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
    ];
    assert.equal(hasImageParts(parts), true);
  });

  it('returns false for a content array with only text', () => {
    const parts = [new LanguageModelTextPart('just text')];
    assert.equal(hasImageParts(parts), false);
  });

  it('mimeType check is case-insensitive (IMAGE/PNG)', () => {
    const part = new LanguageModelDataPart(
      new Uint8Array([1, 2, 3]),
      'IMAGE/PNG',
    );
    assert.equal(isImageDataPart(part), true);
  });
});

describe('convert.toDataUrl — image → data URL conversion', () => {
  it('builds a base64 data URL with the mime type', () => {
    const part = new LanguageModelDataPart(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
    );
    const url = toDataUrl(part);
    assert.equal(
      url,
      'data:image/png;base64,iVBORw==',
    );
  });

  it('encodes an empty byte array as an empty base64 payload', () => {
    const part = new LanguageModelDataPart(new Uint8Array([]), 'image/jpeg');
    assert.equal(toDataUrl(part), 'data:image/jpeg;base64,');
  });

  it('preserves the mime type verbatim (image/webp)', () => {
    const part = new LanguageModelDataPart(
      new Uint8Array([0xff]),
      'image/webp',
    );
    assert.equal(toDataUrl(part), 'data:image/webp;base64,/w==');
  });

  it('round-trips the bytes through Buffer decoding', () => {
    const bytes = new Uint8Array(
      Array.from({ length: 256 }, (_, i) => i),
    );
    const part = new LanguageModelDataPart(bytes, 'image/gif');
    const url = toDataUrl(part);
    const b64 = url.slice('data:image/gif;base64,'.length);
    const decoded = Buffer.from(b64, 'base64');
    assert.deepEqual(
      Array.from(decoded),
      Array.from(bytes),
    );
  });
});

describe('convert.convertMessagesToOpenAI — image forwarding', () => {
  function userMsg(...parts: unknown[]): vscode.LanguageModelChatRequestMessage {
    return {
      role: LanguageModelChatMessageRole.User,
      content: parts as vscode.LanguageModelChatRequestMessage['content'],
      name: undefined,
    };
  }

  it('forwards an image part as an image_url content block with a data URL', () => {
    const imagePart = new LanguageModelDataPart(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
    );
    const result = convertMessagesToOpenAI([
      userMsg(
        new LanguageModelTextPart('what is this?'),
        imagePart,
      ),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(Array.isArray(result[0].content));
    const content = result[0].content as Array<{ type: string; [k: string]: unknown }>;
    // Two parts: text + image_url.
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].text, 'what is this?');
    assert.equal(content[1].type, 'image_url');
    assert.equal(
      (content[1].image_url as { url: string }).url,
      'data:image/png;base64,iVBORw==',
    );
  });

  it('emits an empty text part when the user message has only an image', () => {
    const imagePart = new LanguageModelDataPart(
      new Uint8Array([0xff]),
      'image/jpeg',
    );
    const result = convertMessagesToOpenAI([userMsg(imagePart)]);
    assert.equal(result.length, 1);
    const content = result[0].content as Array<{ type: string }>;
    // Per the convert.ts logic: text part is skipped when empty, so
    // the content array contains only the image_url part.
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'image_url');
  });

  it('does not emit image parts for assistant messages', () => {
    const imagePart = new LanguageModelDataPart(
      new Uint8Array([0x89]),
      'image/png',
    );
    const result = convertMessagesToOpenAI([
      {
        role: LanguageModelChatMessageRole.Assistant,
        content: [
          new LanguageModelTextPart('here is an image'),
          imagePart,
        ] as unknown as vscode.LanguageModelChatRequestMessage['content'],
        name: undefined,
      },
    ]);
    // Assistant message has text → emitted; image is dropped (role !== user).
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.equal(result[0].content, 'here is an image');
    assert.ok(!Array.isArray(result[0].content));
  });
});