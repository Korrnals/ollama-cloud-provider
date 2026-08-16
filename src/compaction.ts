/**
 * Context compaction core — v0.13.0 Slice 1 (spec: docs/compaction-spec.md).
 *
 * Pure module: NO vscode import, NO filesystem/network access. Every
 * side-effecting collaborator (summarizer, evicted-block store) is
 * dependency-injected — sinon cannot stub ESM, the same reason
 * `ssrfGuard.ts` injects its DNS resolver. Production wiring (cheap-model
 * summarizer, local store, provider integration) is Slice 2.
 *
 * Semantics (spec decisions, binding):
 *   - Hysteresis: compact at >= 75% of the model window, target <= 40%.
 *     A fire discharges the machine; it re-arms only when the applied
 *     compaction result lands at <= 40% usage. A compaction that cannot
 *     reach the target stays disarmed — the caller must fall back to the
 *     existing blunt truncation instead of re-firing in a loop.
 *   - Recency window: >= 25% of the window in tokens OR 6 turns
 *     (turn = one user request + everything through the next user
 *     request), whichever covers more; if 6 turns exceed the 25% quota,
 *     take 6 turns anyway. The cut boundary is repaired to the nearest
 *     tool-pair gap — an assistant tool_call is NEVER separated from its
 *     tool results.
 *   - Sliding summary: summarize(previous + only the newly evicted
 *     block) into a checkpoint (Goal first line, Done, Decisions, Open
 *     threads, Turn range). Slice 1 passes `previousSummary = null`;
 *     the stored chain is Slice 2.
 */

/** Fire threshold — fraction of the model window (spec: 75%). */
export const COMPACT_AT_RATIO = 0.75;
/** Post-compaction target / re-arm threshold — fraction of the window (spec: 40%). */
export const COMPACT_TARGET_RATIO = 0.4;
/** Recency token quota — fraction of the window (spec: 25%). */
export const RECENCY_WINDOW_RATIO = 0.25;
/** Recency turn floor — minimum number of recent turns kept verbatim (spec: 6). */
export const RECENCY_TURN_FLOOR = 6;

/**
 * Prefix of the injected summary message content. Identifies the
 * machine-generated checkpoint so downstream consumers (and humans)
 * can distinguish it from author-written system prompts.
 */
export const SUMMARY_MARKER = '[compacted-turns — machine-generated checkpoint summary]';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimates token count from character count. `charsPerToken` is the
 * approximate number of characters per token for the language mix at
 * hand (~4 for English). Rounds up: a partial token still occupies one.
 */
export function estimateTokens(chars: number, charsPerToken: number): number {
  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new RangeError(`estimateTokens: charsPerToken must be a finite positive number, got ${charsPerToken}`);
  }
  if (chars <= 0) return 0;
  return Math.ceil(chars / charsPerToken);
}

// ---------------------------------------------------------------------------
// Hysteresis state machine
// ---------------------------------------------------------------------------

/**
 * Compaction hysteresis state. `armed: true` means the machine will fire
 * when usage reaches {@link COMPACT_AT_RATIO}; a fire sets `armed: false`
 * until {@link applyCompacted} observes the result at or below
 * {@link COMPACT_TARGET_RATIO}.
 */
export interface CompactionState {
  armed: boolean;
}

/**
 * Whether a compaction should fire now. Pure: the caller owns the
 * state transition (a `true` result means "fire", after which the
 * machine is discharged and must not fire again until re-armed).
 */
export function shouldCompact(state: CompactionState, usedTokens: number, windowTokens: number): boolean {
  if (!state.armed) return false;
  return usedTokens >= COMPACT_AT_RATIO * windowTokens;
}

/**
 * Re-evaluates the hysteresis after a compaction result has been applied.
 *
 * A discharged (disarmed) machine re-arms only when the post-compaction
 * usage dropped to the 40% target — that is the completion of one
 * hysteresis cycle (75% fire → 40% land). A compaction that could not
 * reach the target leaves the machine disarmed; the caller falls back
 * to truncation rather than compacting again immediately.
 *
 * Evaluating an armed machine never disarms it — only a fire discharges.
 */
export function applyCompacted(
  state: CompactionState,
  usedTokensAfter: number,
  windowTokens: number,
): CompactionState {
  if (state.armed) return { armed: true };
  return { armed: usedTokensAfter <= COMPACT_TARGET_RATIO * windowTokens };
}

// ---------------------------------------------------------------------------
// Zone split
// ---------------------------------------------------------------------------

/**
 * Context partition for compaction.
 * `system` and `pinned` are kept verbatim; `evictable` is summarized
 * away; `recency` is kept verbatim as the recent tail.
 */
export interface ContextZones<T> {
  system: T[];
  pinned: T[];
  evictable: T[];
  recency: T[];
}

/**
 * Splits messages into compaction zones.
 *
 * - `system`: every `role === 'system'` message, verbatim, never compacted.
 * - `pinned`: messages matching `isPinned` (default: none), verbatim.
 *   Slice 2+ can mark decisions/invariants; Slice 1 keeps the seam.
 * - `recency`: taken from the END — enough messages to cover >= 25% of
 *   `windowTokens` (per `estimate`) OR the last 6 turns, whichever
 *   covers more.
 * - `evictable`: the remainder (candidates for summarization).
 *
 * Turn = one `user` message plus everything through the next `user`
 * message; a leading prefix before the first user message joins the
 * first turn.
 *
 * Tool-pair integrity: the cut is repaired backward while the first
 * recency message is a tool result (`role === 'tool'`, OpenAI wire
 * format) — the assistant that issued the call is absorbed into
 * recency, so a tool_call is never separated from its results.
 */
export function splitZones<T extends { role: string }>(
  messages: readonly T[],
  windowTokens: number,
  estimate: (m: T) => number,
  isPinned: (m: T) => boolean = () => false,
): ContextZones<T> {
  const system: T[] = [];
  const pinned: T[] = [];
  const candidates: T[] = [];
  for (const m of messages) {
    if (m.role === 'system') system.push(m);
    else if (isPinned(m)) pinned.push(m);
    else candidates.push(m);
  }

  // Recency sizing, message-level scan from the end.
  const quota = RECENCY_WINDOW_RATIO * windowTokens;

  // (a) smallest message suffix whose estimated tokens reach the quota
  let byTokens = 0;
  let acc = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    acc += estimate(candidates[i]!);
    byTokens++;
    if (acc >= quota) break;
  }

  // (b) messages covering the last RECENCY_TURN_FLOOR turns
  let byTurns = 0;
  let usersSeen = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    byTurns++;
    if (candidates[i]!.role === 'user') {
      usersSeen++;
      if (usersSeen >= RECENCY_TURN_FLOOR) break;
    }
  }

  const count = Math.min(candidates.length, Math.max(byTokens, byTurns));
  const recency = candidates.slice(candidates.length - count);
  const evictable = candidates.slice(0, candidates.length - count);

  // Tool-pair repair: never split an assistant tool_call from its results.
  // While the first recency message is a tool result, absorb the preceding
  // message (its caller, or an earlier result of the same call) into
  // recency. Extending recency is the safe direction — a tool result is
  // never evicted away from its call.
  while (evictable.length > 0 && recency.length > 0 && recency[0]!.role === 'tool') {
    recency.unshift(evictable.pop()!);
  }

  return { system, pinned, evictable, recency };
}

// ---------------------------------------------------------------------------
// Sliding summary
// ---------------------------------------------------------------------------

/**
 * Builds the summarizer prompt for one sliding-summary step. The previous
 * checkpoint (when the chain exists) is folded in; only the newly evicted
 * block is raw material. The demanded output shape is the checkpoint
 * contract: Goal on the FIRST line, then Done, Decisions, Open threads,
 * Turn range.
 */
export function buildSummaryPrompt(previousSummary: string | null, evictedBlockText: string): string {
  const previousSection =
    previousSummary === null
      ? ''
      : 'PREVIOUS CHECKPOINT (fold into the new one — keep still-open threads, drop settled ones):\n' +
        previousSummary +
        '\n\n';
  return (
    previousSection +
    'Produce a compact checkpoint summary of the EVICTED BLOCK below.\n' +
    'Output shape — exactly these five sections, in this order:\n' +
    "1. Goal: FIRST LINE — restate the user's overarching goal in one sentence.\n" +
    '2. Done: bullet list of completed work.\n' +
    '3. Decisions: bullet list of decisions made, each with a one-line rationale.\n' +
    '4. Open threads: bullet list of unresolved questions and in-flight work.\n' +
    '5. Turn range: the first..last turns covered by this summary.\n' +
    'This checkpoint is machine-generated for context compaction — keep it factual, no commentary.\n\n' +
    'EVICTED BLOCK:\n' +
    evictedBlockText
  );
}

// ---------------------------------------------------------------------------
// Summarizer + store contracts (production impl = Slice 2)
// ---------------------------------------------------------------------------

/** Summarizes the prompt into a checkpoint string. Slice 2: cheap cloud model. */
export type Summarizer = (prompt: string) => Promise<string>;

/** Persists an evicted block; returns a pointer for later retrieval. Slice 2: local file store. */
export interface EvictedStore {
  store(blockText: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Input contract for {@link compactIfNeeded}. */
export interface CompactIfNeededInput<T> {
  messages: readonly T[];
  windowTokens: number;
  charsPerToken: number;
  state: CompactionState;
  summarize: Summarizer;
  store: EvictedStore;
  /** Message → text used for token estimation, store payload and prompt. */
  render: (m: T) => string;
  /** Optional pinned-marker predicate (default: nothing pinned). */
  isPinned?: (m: T) => boolean;
}

/** Result of one compaction check. */
export interface CompactionResult<T> {
  /** `true` when a compaction fired and `messages` is the compacted array. */
  compacted: boolean;
  /** Post-check hysteresis state (input state on passthrough). */
  state: CompactionState;
  /** Messages to send onward: input copy on passthrough, `[system, pinned, summary-inject, recency]` on compaction. */
  messages: T[];
  /** Checkpoint text on compaction, else `null`. */
  summary: string | null;
  /** Evicted-store pointer on compaction, else `null`. */
  pointer: string | null;
}

/**
 * Runs one compaction check over the message history.
 *
 * Flow: estimate usage (sum of per-message `estimateTokens(render(m))`)
 * → `shouldCompact`? no → passthrough (input copied, deps untouched).
 * yes → `splitZones` → empty evictable → passthrough (nothing to
 * compact). Otherwise: `store(evictable rendered)` →
 * `buildSummaryPrompt(null, evictedText)` (Slice 1: no stored chain)
 * → `summarize` → assemble `[system..., pinned..., summary-inject,
 * recency...]` → evaluate the new hysteresis state against the
 * post-compaction usage.
 *
 * Fallback contract (spec decision 1): if `store` or `summarize`
 * throws, the history is passed through untouched with
 * `compacted: false` — compaction never fails the chat; the caller
 * falls back to the existing blunt truncation path.
 */
export async function compactIfNeeded<T extends { role: string }>(
  input: CompactIfNeededInput<T>,
): Promise<CompactionResult<T>> {
  const { messages, windowTokens, charsPerToken, state, summarize, store, render } = input;
  const isPinned = input.isPinned ?? (() => false);
  const estimate = (m: T): number => estimateTokens(render(m).length, charsPerToken);
  const usedTokens = messages.reduce((sum, m) => sum + estimate(m), 0);

  const passthrough = (): CompactionResult<T> => ({
    compacted: false,
    state,
    messages: [...messages],
    summary: null,
    pointer: null,
  });

  if (!shouldCompact(state, usedTokens, windowTokens)) return passthrough();

  const zones = splitZones(messages, windowTokens, estimate, isPinned);
  if (zones.evictable.length === 0) return passthrough();

  const evictedText = zones.evictable.map(render).join('\n\n');
  let pointer: string;
  let summary: string;
  try {
    pointer = await store.store(evictedText);
    summary = await summarize(buildSummaryPrompt(null, evictedText));
  } catch {
    return passthrough();
  }

  // Spec assembles the summary message as {role:'system', content: marker +
  // summary + pointer}. T is only constrained to {role}, so the literal is
  // cast — Slice 2 production callers use OpenAI-shaped messages where the
  // cast is exact.
  const summaryMessage = {
    role: 'system',
    content: `${SUMMARY_MARKER}\n${summary}\n[evicted-block pointer: ${pointer}]`,
  } as unknown as T;

  const assembled: T[] = [...zones.system, ...zones.pinned, summaryMessage, ...zones.recency];
  const usedAfter = assembled.reduce((sum, m) => sum + estimate(m), 0);
  // The fire discharged the machine above; evaluate re-arm against the result.
  const nextState = applyCompacted({ armed: false }, usedAfter, windowTokens);

  return { compacted: true, state: nextState, messages: assembled, summary, pointer };
}
