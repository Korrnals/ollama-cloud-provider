import { strict as assert } from 'node:assert';
import {
  clearCapabilityCache,
  mark404,
  reset404s,
  shouldAutoSwitch,
  shouldRetryAfterSilence,
  sweepStaleEntries,
} from '../../src/capabilityCache.js';

// v0.9.0 — Coverage gap (Code Review finding 3/3). The auto-recovery
// primitives (mark404, reset404s, shouldAutoSwitch, shouldRetryAfterSilence)
// drive the `preferredEndpoint: 'auto'` routing decision but had NO direct
// unit tests. These tests pin the state machine: 3 consecutive 404s in 5 min
// triggers switch; any success resets; 5 min of silence triggers return.
//
// Time control: the project does not bundle sinon (checked package.json), so
// these tests control the sliding window by mocking `Date.now`. Each test
// sets a deterministic base time in `beforeEach`; tests that exercise the
// window override `Date.now` inline and the original is restored in
// `afterEach`. `clearCapabilityCache` runs in `beforeEach` so the internal
// `endpoint404Cache` Map is empty at the start of every case (no leakage).
//
// AUTO_SWITCH_THRESHOLD = 3, AUTO_SWITCH_WINDOW_MS = 300_000 (5 min),
// RETURN_TO_NATIVE_SILENCE_MS = 300_000 (5 min) — see src/capabilityCache.ts.
const BASE_TIME = 1_000_000; // deterministic epoch (ms)
const WINDOW_MS = 300_000; // mirrors AUTO_SWITCH_WINDOW_MS / RETURN_TO_NATIVE_SILENCE_MS

let realDateNow: () => number;

describe('capabilityCache — v0.9.0 auto-recovery state machine', () => {
  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = () => BASE_TIME;
    clearCapabilityCache();
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it('mark404 increments the counter within the 5-min window', () => {
    // The counter is internal; observe it via shouldAutoSwitch, which only
    // trips at the threshold (3). Two marks stay below the threshold, three
    // cross it — proving each mark incremented rather than reset.
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'count 1 not at threshold');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'count 2 not at threshold');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), true, 'count 3 crossed threshold');
  });

  it('mark404 resets the counter when called outside the 5-min window (404 after silence starts fresh at 1)', () => {
    // Three rapid 404s cross the threshold.
    mark404('c1', 'native');
    mark404('c1', 'native');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), true, 'precondition: 3 strikes');

    // A 404 arriving AFTER the window elapses must NOT continue the old
    // streak — it starts a fresh count at 1, dropping back below threshold.
    Date.now = () => BASE_TIME + WINDOW_MS + 1;
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'post-window 404 reset to 1');
  });

  it('shouldAutoSwitch returns false at counts 1 and 2, true at count 3 (within window)', () => {
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'count 1');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'count 2');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), true, 'count 3');
  });

  it('shouldAutoSwitch returns false if the last 404 is older than 5 min (window expired)', () => {
    // Cross the threshold while in-window.
    mark404('c1', 'native');
    mark404('c1', 'native');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), true, 'precondition: threshold reached');

    // Time passes with NO new mark404 — the window expires even though the
    // count is still 3. shouldAutoSwitch must read the last404At timestamp,
    // not just the counter.
    Date.now = () => BASE_TIME + WINDOW_MS + 1;
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'expired window suppresses switch');
  });

  it('reset404s clears the counter on success (after reset, shouldAutoSwitch is false)', () => {
    mark404('c1', 'native');
    mark404('c1', 'native');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), true, 'precondition: threshold reached');

    // A successful response from the endpoint resets the streak. The
    // provider calls reset404s in its success path (markNativeChatAvailable
    // is separate — reset404s is the auto-recovery counter specifically).
    reset404s('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'reset cleared the streak');
  });

  it('shouldRetryAfterSilence returns false right after a 404 and true after 5+ min of silence', () => {
    mark404('c1', 'native');
    // Immediately after the 404, the connection should NOT attempt to return
    // to the native endpoint — it has just been observed failing.
    assert.equal(shouldRetryAfterSilence('c1'), false, 'right after 404 — no return yet');

    // After RETURN_TO_NATIVE_SILENCE_MS (5 min) with no further 404s, the
    // outage is presumed transient and the provider may retry the primary.
    Date.now = () => BASE_TIME + WINDOW_MS + 1;
    assert.equal(shouldRetryAfterSilence('c1'), true, 'after 5+ min silence — return to native');
  });

  it('anti-flapping: interleaved 404/success/404/success never reaches shouldAutoSwitch=true', () => {
    // A flapping endpoint (404, success, 404, success, ...) must NEVER trip
    // the auto-switch threshold. Each success resets the consecutive count,
    // so a steady stream of single 404s separated by successes stays at 1.
    mark404('c1', 'native'); // count 1
    reset404s('c1', 'native'); // success → reset to 0
    mark404('c1', 'native'); // count 1 again
    reset404s('c1', 'native'); // reset
    mark404('c1', 'native'); // count 1 again
    assert.equal(shouldAutoSwitch('c1', 'native'), false, 'flapping never reaches threshold');
  });

  it('tracks native/chat/responses endpoints independently per connection', () => {
    // The cache is keyed by `<connectionId>:<endpointType>`, so a 3-strike
    // on native must not bleed into chat, responses, or another connection.
    mark404('c1', 'native');
    mark404('c1', 'native');
    mark404('c1', 'native');
    assert.equal(shouldAutoSwitch('c1', 'native'), true, 'native hit threshold');
    assert.equal(shouldAutoSwitch('c1', 'chat'), false, 'chat untouched');
    assert.equal(shouldAutoSwitch('c1', 'responses'), false, 'responses untouched');
    assert.equal(shouldAutoSwitch('c2', 'native'), false, 'other connection untouched');

    // shouldRetryAfterSilence only inspects entries for the queried connection.
    assert.equal(shouldRetryAfterSilence('c2'), false, 'c2 has no 404 history');
  });

  it('shouldRetryAfterSilence is scoped to the queried connection id', () => {
    // c1 has a recent 404; c2 is silent. shouldRetryAfterSilence('c1') must be
    // false (recent) while shouldRetryAfterSilence('c2') is false (no history),
    // and advancing time flips only c1 (the one with a stale 404).
    mark404('c1', 'native');
    assert.equal(shouldRetryAfterSilence('c1'), false);
    assert.equal(shouldRetryAfterSilence('c2'), false);
    Date.now = () => BASE_TIME + WINDOW_MS + 1;
    assert.equal(shouldRetryAfterSilence('c1'), true, 'c1 silence elapsed');
    assert.equal(shouldRetryAfterSilence('c2'), false, 'c2 still no history');
  });

  it('sweepStaleEntries removes entries older than the cutoff and keeps recent ones', () => {
    // Seed an OLD entry: last404At 11.6 min ago (above the 10-min cutoff).
    Date.now = () => BASE_TIME - 700_000;
    mark404('cold', 'native');
    // Seed a RECENT entry: last404At 1.6 min ago (below the cutoff).
    Date.now = () => BASE_TIME - 100_000;
    mark404('warm', 'native');

    // Sweep at the present time with a 10-min (600_000ms) cutoff.
    Date.now = () => BASE_TIME;
    const swept = sweepStaleEntries(600_000);

    // Exactly one entry (cold) was stale and removed; warm survived.
    assert.equal(swept, 1, 'removed the single stale entry');
    assert.equal(sweepStaleEntries(600_000), 0, 'warm entry survived the first sweep');
  });
});
