import assert from 'node:assert';
import {
  SUMMARY_MARKER,
  applyCompacted,
  buildSummaryPrompt,
  compactIfNeeded,
  estimateTokens,
  shouldCompact,
  splitZones,
  type CompactionState,
  type EvictedStore,
  type Summarizer,
} from '../../src/compaction.js';

/**
 * v0.13.0 Slice 1 — compaction core unit tests (spec: docs/compaction-spec.md).
 *
 * The module is pure and dependency-injected: the summarizer and the
 * evicted-block store are fakes recording their calls, exactly like the
 * DNS resolver in the ssrfGuard tests. No network, no filesystem.
 *
 * Test math uses `charsPerToken = 1` and content-length estimates, so
 * every token number below is exact. Tags embedded in message content
 * (t01, t02, …) make zone membership assertable by substring.
 */

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

const render = (m: Msg): string => m.content;
const est = (m: Msg): number => m.content.length;

function pad(tag: string, n: number): string {
  return tag + 'x'.repeat(Math.max(0, n - tag.length));
}
const sys = (tag: string, n = 50): Msg => ({ role: 'system', content: pad(tag, n) });
const usr = (tag: string, n = 50): Msg => ({ role: 'user', content: pad(tag, n) });
const asr = (tag: string, n = 50): Msg => ({ role: 'assistant', content: pad(tag, n) });
const tol = (tag: string, n = 50): Msg => ({ role: 'tool', content: pad(tag, n) });

/** `count` two-message turns [user, assistant], 50 tokens each message. */
function turns(count: number, perMsg = 50): Msg[] {
  const out: Msg[] = [];
  for (let i = 1; i <= count; i++) {
    const tag = `t${String(i).padStart(2, '0')}`;
    out.push(usr(`${tag}u`, perMsg), asr(`${tag}a`, perMsg));
  }
  return out;
}

function fakeStore(pointer: string, err?: Error): EvictedStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: async (blockText: string): Promise<string> => {
      calls.push(blockText);
      if (err) throw err;
      return pointer;
    },
  };
}

function fakeSummarizer(summary: string, err?: Error): Summarizer & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (prompt: string): Promise<string> => {
    calls.push(prompt);
    if (err) throw err;
    return summary;
  };
  return Object.assign(fn, { calls });
}

describe('compaction (v0.13.0 slice 1)', () => {
  describe('estimateTokens', () => {
    it('divides chars by charsPerToken', () => {
      assert.strictEqual(estimateTokens(1000, 4), 250);
      assert.strictEqual(estimateTokens(999, 3), 333);
    });

    it('rounds up partial tokens and treats non-positive chars as zero', () => {
      assert.strictEqual(estimateTokens(1001, 4), 251);
      assert.strictEqual(estimateTokens(0, 4), 0);
      assert.strictEqual(estimateTokens(-5, 4), 0);
    });

    it('throws RangeError on non-positive or non-finite charsPerToken', () => {
      assert.throws(() => estimateTokens(100, 0), RangeError);
      assert.throws(() => estimateTokens(100, -1), RangeError);
      assert.throws(() => estimateTokens(100, Number.NaN), RangeError);
    });
  });

  describe('shouldCompact (hysteresis)', () => {
    it('fires only at or above 75% while armed', () => {
      const armed: CompactionState = { armed: true };
      const window = 1000;
      assert.strictEqual(shouldCompact(armed, 740, window), false);
      assert.strictEqual(shouldCompact(armed, 750, window), true);
      assert.strictEqual(shouldCompact(armed, 900, window), true);
    });

    it('fires once — a discharged machine stays silent even above threshold', () => {
      const discharged: CompactionState = { armed: false };
      assert.strictEqual(shouldCompact(discharged, 900, 1000), false);
      assert.strictEqual(shouldCompact(discharged, 300, 1000), false);
    });
  });

  describe('applyCompacted (re-arm at 40%)', () => {
    it('re-arms a discharged machine only at or below the 40% target', () => {
      const discharged: CompactionState = { armed: false };
      const window = 1000;
      assert.deepStrictEqual(applyCompacted(discharged, 500, window), { armed: false });
      assert.deepStrictEqual(applyCompacted(discharged, 410, window), { armed: false });
      assert.deepStrictEqual(applyCompacted(discharged, 400, window), { armed: true });
      assert.deepStrictEqual(applyCompacted(discharged, 200, window), { armed: true });
    });

    it('never disarms an armed machine by evaluation', () => {
      assert.deepStrictEqual(applyCompacted({ armed: true }, 900, 1000), { armed: true });
    });
  });

  describe('splitZones', () => {
    it('puts every system message into the system zone, verbatim, in order', () => {
      const s1 = sys('s1');
      const s2 = sys('s2');
      const u1 = usr('t01u');
      const a1 = asr('t01a');
      const zones = splitZones([s1, u1, s2, a1], 1000, est);
      assert.deepStrictEqual(zones.system, [s1, s2]);
      assert.strictEqual(zones.system[0], s1);
      assert.strictEqual(zones.system[1], s2);
      assert.strictEqual(zones.pinned.length, 0);
      assert.strictEqual(zones.evictable.length + zones.recency.length, 2);
    });

    it('covers at least 25% of the window in tokens for recency', () => {
      // 10 turns × 100 tokens = 1000 total; window 2800 → quota 700.
      // Message scan from the end needs 14 messages (14 × 50 = 700);
      // the 6-turn floor would only take 12 — the token quota wins.
      const msgs = turns(10);
      const zones = splitZones(msgs, 2800, est);
      const recencyTokens = zones.recency.reduce((s, m) => s + est(m), 0);
      assert.ok(recencyTokens >= 700, `recency ${recencyTokens} < quota 700`);
      assert.strictEqual(zones.recency.length, 14);
      assert.strictEqual(zones.evictable.length, 6);
      assert.strictEqual(zones.recency[0], msgs[6]);
    });

    it('applies the 6-turn floor when the token quota is met sooner', () => {
      // 8 turns × 200 tokens = 1600; window 1000 → quota 250, met by
      // 3 messages — but the floor forces the last 6 turns (12 messages).
      const msgs = turns(8, 100);
      const zones = splitZones(msgs, 1000, est);
      assert.strictEqual(zones.recency.length, 12);
      assert.strictEqual(zones.recency[0], msgs[4]); // user of turn 3
      assert.strictEqual(zones.evictable.length, 4);
    });

    it('never splits an assistant tool_call from its tool results at the boundary', () => {
      // 10 turns × [user, assistant, tool], tags make each message 4
      // tokens; window 400 → quota 100. Message scan needs 25 messages
      // (25 × 4 = 100) — more than the 6-turn floor (18) — so the raw
      // cut head is the tool of turn 2; the repair absorbs its caller.
      const msgs: Msg[] = [];
      for (let i = 1; i <= 10; i++) {
        const tag = `t${String(i).padStart(2, '0')}`;
        msgs.push(usr(`${tag}u`, 2), asr(`${tag}a`, 2), tol(`${tag}r`, 2));
      }
      const zones = splitZones(msgs, 400, est);
      assert.strictEqual(zones.recency[0]!.role, 'assistant');
      assert.strictEqual(zones.recency[1]!.role, 'tool');
      assert.strictEqual(zones.recency[0], msgs[4]); // assistant of turn 2
      assert.strictEqual(zones.recency[1], msgs[5]); // its tool result
      assert.notStrictEqual(zones.evictable[zones.evictable.length - 1]!.role, 'assistant');
      // Integrity: every tool result in recency is preceded by its
      // caller (or an earlier result of the same call) inside recency.
      for (let i = 0; i < zones.recency.length; i++) {
        if (zones.recency[i]!.role === 'tool') {
          assert.ok(i > 0, 'tool result must not lead recency');
        }
      }
    });

    it('respects the pinned predicate and defaults to nothing pinned', () => {
      const pinned = asr('PIN');
      const msgs = [sys('s1'), ...turns(8), pinned];
      const withPredicate = splitZones(msgs, 1000, est, (m) => m.content.startsWith('PIN'));
      assert.deepStrictEqual(withPredicate.pinned, [pinned]);
      assert.ok(withPredicate.evictable.every((m) => m !== pinned));
      assert.ok(withPredicate.recency.every((m) => m !== pinned));

      const withoutPredicate = splitZones(msgs, 1000, est);
      assert.strictEqual(withoutPredicate.pinned.length, 0);
    });

    it('leaves evictable empty when the floor covers everything', () => {
      const msgs = turns(3);
      const zones = splitZones(msgs, 1000, est);
      assert.strictEqual(zones.evictable.length, 0);
      assert.strictEqual(zones.recency.length, 6);
    });
  });

  describe('buildSummaryPrompt', () => {
    it('demands the checkpoint shape with Goal on the first line', () => {
      const prompt = buildSummaryPrompt(null, 'EVICTED-CONTENT');
      assert.match(prompt, /Goal: FIRST LINE/i);
      assert.match(prompt, /Done:/);
      assert.match(prompt, /Decisions:/);
      assert.match(prompt, /Open threads:/);
      assert.match(prompt, /Turn range:/);
      assert.ok(prompt.includes('EVICTED-CONTENT'));
    });

    it('folds the previous summary in when present', () => {
      const prompt = buildSummaryPrompt('PREVIOUS-CHECKPOINT', 'EVICTED-CONTENT');
      assert.ok(prompt.includes('PREVIOUS-CHECKPOINT'));
      assert.ok(prompt.includes('EVICTED-CONTENT'));
    });
  });

  describe('compactIfNeeded', () => {
    it('passes through untouched below the threshold, deps not called', async () => {
      const messages = [sys('s1'), ...turns(3)];
      const store = fakeStore('ptr-1');
      const summarize = fakeSummarizer('unused');
      const result = await compactIfNeeded({
        messages,
        windowTokens: 4000, // 75% = 3000; used = 350
        charsPerToken: 1,
        state: { armed: true },
        summarize,
        store,
        render,
      });
      assert.strictEqual(result.compacted, false);
      assert.deepStrictEqual(result.messages, messages);
      assert.notStrictEqual(result.messages, messages); // copy, not alias
      assert.deepStrictEqual(result.state, { armed: true });
      assert.strictEqual(result.summary, null);
      assert.strictEqual(result.pointer, null);
      assert.strictEqual(store.calls.length, 0);
      assert.strictEqual(summarize.calls.length, 0);
    });

    it('passes through when the floor covers everything (nothing to compact)', async () => {
      // used = 410 >= 75% of 500, but 3 turns fit entirely into the
      // 6-turn recency floor → evictable empty → passthrough.
      const messages = [sys('s1'), usr('t01u', 60), asr('t01a', 60), usr('t02u', 60), asr('t02a', 60), usr('t03u', 60), asr('t03a', 60)];
      const store = fakeStore('ptr-1');
      const summarize = fakeSummarizer('unused');
      const result = await compactIfNeeded({
        messages,
        windowTokens: 500,
        charsPerToken: 1,
        state: { armed: true },
        summarize,
        store,
        render,
      });
      assert.strictEqual(result.compacted, false);
      assert.deepStrictEqual(result.messages, messages);
      assert.strictEqual(store.calls.length, 0);
      assert.strictEqual(summarize.calls.length, 0);
    });

    it('compacts: assembles [system, pinned, summary-inject, recency], returns pointer, discharges state', async () => {
      // window 1500: fire at 1125; used = 2050. Recency = 6 turns = 600
      // tokens; post-compaction usage ≈ 816 > 600 (40%) → stays disarmed.
      const s1 = sys('s1');
      const pin = asr('PIN');
      const history = turns(20);
      history.splice(9, 1, pin); // replace assistant of turn 5 with pinned
      const messages = [s1, ...history];
      const store = fakeStore('ptr-1');
      const summarize = fakeSummarizer('GOAL: keep the goal. DONE: work.');
      const result = await compactIfNeeded({
        messages,
        windowTokens: 1500,
        charsPerToken: 1,
        state: { armed: true },
        summarize,
        store,
        render,
        isPinned: (m) => m.content.startsWith('PIN'),
      });

      assert.strictEqual(result.compacted, true);
      // [system, pinned, summary-inject, 12 recency messages] = 15
      assert.strictEqual(result.messages.length, 15);
      assert.strictEqual(result.messages[0], s1);
      assert.strictEqual(result.messages[1], pin);
      const injected = result.messages[2] as Msg;
      assert.strictEqual(injected.role, 'system');
      assert.ok(injected.content.startsWith(SUMMARY_MARKER));
      assert.ok(injected.content.includes('GOAL: keep the goal.'));
      assert.ok(injected.content.includes('[evicted-block pointer: ptr-1]'));
      assert.strictEqual(result.messages[3], history[28]); // user of turn 15
      assert.strictEqual(result.messages[14], history[39]); // assistant of turn 20
      // Evicted turns are gone from the assembled history.
      assert.strictEqual(result.messages.indexOf(history[1]), -1); // t01 user
      // Store got exactly the evictable block; summarizer got it embedded.
      assert.strictEqual(store.calls.length, 1);
      assert.ok(store.calls[0]!.includes('t01u'));
      assert.ok(store.calls[0]!.includes('t14a'));
      assert.ok(!store.calls[0]!.includes('t15u'));
      assert.ok(!store.calls[0]!.includes('PIN'));
      assert.strictEqual(summarize.calls.length, 1);
      assert.ok(summarize.calls[0]!.includes('t01u'));
      assert.strictEqual(result.pointer, 'ptr-1');
      assert.strictEqual(result.summary, 'GOAL: keep the goal. DONE: work.');
      assert.deepStrictEqual(result.state, { armed: false });
    });

    it('re-arms when the compaction result lands at or below the 40% target', async () => {
      // window 4000: fire at 3000; used = 4050. Recency = quota 1000
      // (20 messages = 10 turns); post-compaction usage ≈ 1166 <= 1600.
      const messages = [sys('s1'), ...turns(40)];
      const result = await compactIfNeeded({
        messages,
        windowTokens: 4000,
        charsPerToken: 1,
        state: { armed: true },
        summarize: fakeSummarizer('GOAL: keep the goal. DONE: work.'),
        store: fakeStore('ptr-1'),
        render,
      });
      assert.strictEqual(result.compacted, true);
      assert.strictEqual(result.messages.length, 1 + 1 + 20); // sys + inject + recency
      assert.strictEqual(result.messages[2], messages[61]); // user of turn 31
      assert.deepStrictEqual(result.state, { armed: true });
    });

    it('falls back to passthrough when the summarizer throws', async () => {
      const messages = [sys('s1'), ...turns(20)];
      const store = fakeStore('ptr-1');
      const summarize = fakeSummarizer('unused', new Error('model unavailable'));
      const result = await compactIfNeeded({
        messages,
        windowTokens: 1500,
        charsPerToken: 1,
        state: { armed: true },
        summarize,
        store,
        render,
      });
      assert.strictEqual(result.compacted, false);
      assert.deepStrictEqual(result.messages, messages);
      assert.deepStrictEqual(result.state, { armed: true });
      assert.strictEqual(result.summary, null);
      assert.strictEqual(result.pointer, null);
      assert.strictEqual(store.calls.length, 1); // store ran before the failure
    });

    it('falls back to passthrough when the store throws, summarizer untouched', async () => {
      const messages = [sys('s1'), ...turns(20)];
      const store = fakeStore('ptr-1', new Error('disk full'));
      const summarize = fakeSummarizer('unused');
      const result = await compactIfNeeded({
        messages,
        windowTokens: 1500,
        charsPerToken: 1,
        state: { armed: true },
        summarize,
        store,
        render,
      });
      assert.strictEqual(result.compacted, false);
      assert.deepStrictEqual(result.messages, messages);
      assert.strictEqual(summarize.calls.length, 0);
    });
  });
});
