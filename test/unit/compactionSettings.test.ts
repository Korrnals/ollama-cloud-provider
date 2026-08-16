import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * v0.13.0 Slice 2 — settings defaults test (spec:
 * docs/compaction-spec.md § Slice 2 tests: "defaults present in
 * package.json (enabled=false, model=gpt-oss:20b)").
 *
 * Reads the real package.json from the repo root (three levels up
 * from the compiled out/test/unit/*.test.js), so the shipped
 * defaults are pinned, not the defaults baked into code paths.
 */

interface PackageJson {
  contributes: {
    configuration: {
      properties: Record<
        string,
        { type: string; default: unknown; scope?: string; description?: string }
      >;
    };
  };
}

const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as PackageJson;

const properties = pkg.contributes.configuration.properties;

describe('compaction settings defaults (v0.13.0 slice 2)', () => {
  it('declares ollamaCloud.compaction.enabled with default false', () => {
    const setting = properties['ollamaCloud.compaction.enabled'];
    assert.ok(setting, 'setting must exist in package.json');
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, false, 'compaction is OFF by default');
    assert.equal(setting.scope, 'application');
  });

  it('declares ollamaCloud.compaction.model with default gpt-oss:20b', () => {
    const setting = properties['ollamaCloud.compaction.model'];
    assert.ok(setting, 'setting must exist in package.json');
    assert.equal(setting.type, 'string');
    assert.equal(setting.default, 'gpt-oss:20b');
    assert.equal(setting.scope, 'application');
    // Spec: the description must state the model is used ONLY for
    // context summarization, not for chat.
    assert.match(
      setting.description ?? '',
      /[Oo][Nn][Ll][Yy][^.]*summariz/i,
      'description states summarization-only usage',
    );
  });
});
