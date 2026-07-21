import { strict as assert } from 'node:assert';
import { redactSensitive } from '../../src/logger.js';

describe('logger.redactSensitive', () => {
  it('redacts Authorization: Bearer header (with space)', () => {
    const input = 'Authorization: Bearer sk-test-1234567890';
    const out = redactSensitive(input);
    assert.equal(out, 'Authorization: Bearer [REDACTED]');
    assert.ok(!out.includes('sk-test-1234567890'));
  });

  it('redacts Authorization:Bearer header (no space after colon)', () => {
    const input = 'Authorization:Bearer sk-test-1234567890';
    const out = redactSensitive(input);
    assert.equal(out, 'Authorization: Bearer [REDACTED]');
  });

  it('redacts standalone Bearer token', () => {
    const input = 'token=Bearer abc-1234-5678';
    const out = redactSensitive(input);
    assert.equal(out, 'token=Bearer [REDACTED]');
  });

  it('redacts JSON api_key field (snake_case)', () => {
    const input = '{"api_key":"supersecret","other":"keep"}';
    const out = redactSensitive(input);
    assert.equal(out, '{"api_key":"[REDACTED]","other":"keep"}');
  });

  it('redacts JSON apiKey field (camelCase)', () => {
    const input = '{"apiKey":"supersecret"}';
    const out = redactSensitive(input);
    assert.equal(out, '{"apiKey":"[REDACTED]"}');
  });

  it('redacts api_key= query/CLI form', () => {
    const input = 'https://api.example.com/?api_key=supersecret123&foo=1';
    const out = redactSensitive(input);
    assert.equal(out, 'https://api.example.com/?api_key=[REDACTED]&foo=1');
  });

  it('redacts sk- prefixed OpenAI-style key', () => {
    const input = 'sk-1234567890abcdefghij1234';
    const out = redactSensitive(input);
    assert.equal(out, 'sk-[REDACTED]');
  });

  it('passes through empty string', () => {
    assert.equal(redactSensitive(''), '');
  });

  it('passes through string with no match', () => {
    const input = 'just a normal log line about cats';
    assert.equal(redactSensitive(input), input);
  });

  it('redacts multiple patterns in one string', () => {
    const input = 'Authorization: Bearer abc123 and api_key=secret456 and sk-abcdefghij1234567890';
    const out = redactSensitive(input);
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('secret456'));
    assert.ok(!out.includes('abcdefghij1234567890'));
    assert.ok(out.includes('[REDACTED]'));
  });

  it('does NOT redact short Bearer-less tokens', () => {
    // pattern requires 4+ chars after Bearer
    const input = 'Bearer abc';
    const out = redactSensitive(input);
    // "abc" is 3 chars, below the {4,} threshold — kept as-is
    assert.equal(out, 'Bearer abc');
  });

  describe('base64 image data URL redaction', () => {
    it('redacts a data:image/png;base64,... payload', () => {
      const input = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      const out = redactSensitive(input);
      assert.equal(out, 'data:image/[mime];base64,[REDACTED]');
      assert.ok(!out.includes('iVBORw0KGgoAAAANSUhEUg=='));
      assert.ok(!out.includes('iVBORw0KGgo'));
    });

    it('redacts a data:image/jpeg;base64,... payload', () => {
      const input = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
      const out = redactSensitive(input);
      assert.equal(out, 'data:image/[mime];base64,[REDACTED]');
      assert.ok(!out.includes('/9j/4AAQSkZJRgABAQ=='));
    });

    it('redacts a data:image/webp;base64,... payload', () => {
      const input = 'data:image/webp;base64,UklGRkBAAABXRUJQ==';
      const out = redactSensitive(input);
      assert.equal(out, 'data:image/[mime];base64,[REDACTED]');
    });

    it('redacts a data:image/gif;base64,... payload', () => {
      const input = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BA==';
      const out = redactSensitive(input);
      assert.equal(out, 'data:image/[mime];base64,[REDACTED]');
    });

    it('redacts a data:image/svg+xml;base64,... payload', () => {
      // svg+xml exercises the [a-z+]+ mime character class (the + literal).
      const input = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPg==';
      const out = redactSensitive(input);
      assert.equal(out, 'data:image/[mime];base64,[REDACTED]');
      assert.ok(!out.includes('PHN2ZyB4'));
    });

    it('matches case-insensitively on the mime type (image/PNG)', () => {
      const input = 'data:image/PNG;base64,iVBORw0KGgoAAAANSUhEUg==';
      const out = redactSensitive(input);
      assert.equal(out, 'data:image/[mime];base64,[REDACTED]');
      assert.ok(!out.includes('iVBORw0KGgo'));
    });

    it('redacts multiple data URLs in one string', () => {
      const input =
        'first: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== second: data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
      const out = redactSensitive(input);
      assert.equal(out, 'first: data:image/[mime];base64,[REDACTED] second: data:image/[mime];base64,[REDACTED]');
      assert.ok(!out.includes('iVBORw0KGgo'));
      assert.ok(!out.includes('/9j/4AAQSkZJRg'));
    });

    it('does NOT redact a non-data: URL that merely contains base64-looking text', () => {
      const input = 'https://example.com/image/png;base64,not-a-data-url';
      const out = redactSensitive(input);
      assert.equal(out, input);
    });

    it('does NOT redact a bare base64 string without the data:image prefix', () => {
      const input = 'iVBORw0KGgoAAAANSUhEUg==';
      const out = redactSensitive(input);
      assert.equal(out, input);
    });

    it('does NOT leak any base64 payload characters via the replacement', () => {
      const payload = 'iVBORw0KGgoAAAANSUhEUg==';
      const input = `data:image/png;base64,${payload}`;
      const out = redactSensitive(input);
      assert.ok(!out.includes(payload));
      // verify no base64 payload char survived into the output
      for (const ch of payload) {
        // allow [REDACTED] tokens and structural chars only
        if ('[REDACTED]data:image/m;b6+'.includes(ch)) continue;
        assert.ok(!out.includes(ch), `leaked char ${ch} in redacted output: ${out}`);
      }
    });

    it('co-exists with existing patterns — does not weaken prior redactions', () => {
      const input =
        'Authorization: Bearer sk-test-1234567890 and data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      const out = redactSensitive(input);
      assert.ok(!out.includes('sk-test-1234567890'));
      assert.ok(!out.includes('iVBORw0KGgo'));
      assert.ok(out.includes('Authorization: Bearer [REDACTED]'));
      assert.ok(out.includes('data:image/[mime];base64,[REDACTED]'));
    });

    it('does NOT redact an empty-payload data URL (no base64 body)', () => {
      // Pattern requires at least one base64 char after the comma — the
      // empty form `data:image/png;base64,` is not matched and passes through.
      const input = 'data:image/png;base64,';
      const out = redactSensitive(input);
      assert.equal(out, input);
    });
  });
});