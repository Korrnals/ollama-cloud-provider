import { strict as assert } from 'node:assert';
import { formatUsageLog } from '../../src/provider.js';
import type { UsageInfo } from '../../src/protocolTypes.js';

/**
 * Issue #41 — Strand 3.2: unit tests for the token-audit fields
 * `formatUsageLog` appends when the caller passes `requestChars` +
 * `charsPerToken`. The audit compares a locally-estimated input token
 * count against the server-reported `inputTokens` and flags a delta
 * >20% in either direction.
 *
 * These tests assert the high-signal fields that would regress
 * silently if the audit logic were removed or weakened:
 *   - `estimatedTokens=` present when both new params are passed
 *   - `delta=` present when the delta exceeds 20%
 *   - `delta=` absent when the delta is within 20%
 *   - backward compatibility: no audit fields when the new params are
 *     omitted (existing callers + the pre-#41 log shape)
 */
describe('provider.formatUsageLog — token audit (Issue #41)', () => {
  const baseUsage: UsageInfo = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  };

  it('emits the baseline usage fields with no audit params (backward compatible)', () => {
    const line = formatUsageLog('gpt-oss:120b', baseUsage);
    assert.match(line, /^\[gpt-oss:120b\] input=100 output=50 total=150$/);
    assert.doesNotMatch(line, /estimatedTokens/);
    assert.doesNotMatch(line, /delta/);
  });

  it('appends estimatedTokens when requestChars + charsPerToken are provided', () => {
    // 400 chars / 4 chars-per-token = 100 estimated tokens.
    const line = formatUsageLog('m', baseUsage, 400, 4);
    assert.match(line, /estimatedTokens=100/);
  });

  it('floors estimatedTokens at 1 (never zero) for tiny requests', () => {
    const line = formatUsageLog('m', baseUsage, 0, 4);
    assert.match(line, /estimatedTokens=1/);
  });

  it('omits estimatedTokens when charsPerToken is missing or zero', () => {
    const noCharsPerToken = formatUsageLog('m', baseUsage, 400);
    assert.doesNotMatch(noCharsPerToken, /estimatedTokens/);
    const zeroCharsPerToken = formatUsageLog('m', baseUsage, 400, 0);
    assert.doesNotMatch(zeroCharsPerToken, /estimatedTokens/);
  });

  it('appends delta when estimated tokens exceed server inputTokens by >20%', () => {
    // Server counted 100 input tokens; we estimated 200 — a 100%
    // overshoot, the signal of redundant content or a convert bug.
    const line = formatUsageLog('m', baseUsage, 800, 4);
    assert.match(line, /estimatedTokens=200/);
    assert.match(line, /delta=\+100%/);
    assert.match(line, /audit: check convert path for redundancy/);
  });

  it('appends delta when server counted more than estimated (under-count, >20%)', () => {
    // Server counted 100; we estimated only 25 — a 75% under-count.
    // The audit fires in BOTH directions (server over OR under).
    const line = formatUsageLog('m', baseUsage, 100, 4);
    assert.match(line, /estimatedTokens=25/);
    assert.match(line, /delta=-75%/);
  });

  it('omits delta when the estimate is within 20% of server inputTokens', () => {
    // Server counted 100; we estimated 110 — a 10% delta, within the
    // 20% threshold. No `delta=` field — the audit is silent when
    // the estimate agrees with the server.
    const line = formatUsageLog('m', baseUsage, 440, 4);
    assert.match(line, /estimatedTokens=110/);
    assert.doesNotMatch(line, /delta/);
  });

  it('omits delta when server inputTokens is undefined (nothing to compare)', () => {
    const usage: UsageInfo = { outputTokens: 50 };
    const line = formatUsageLog('m', usage, 400, 4);
    assert.match(line, /estimatedTokens=100/);
    assert.doesNotMatch(line, /delta/);
  });

  it('treats the 20% boundary as within-threshold (no delta at exactly 20%)', () => {
    // Server counted 100; we estimated 120 — exactly 20%. The check
    // is `ratio > 0.2`, so 20% exactly does NOT fire the delta.
    const line = formatUsageLog('m', baseUsage, 480, 4);
    assert.match(line, /estimatedTokens=120/);
    assert.doesNotMatch(line, /delta/);
  });
});