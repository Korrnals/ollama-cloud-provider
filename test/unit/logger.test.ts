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
});