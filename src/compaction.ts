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
 *     threads, Turn range). Slice 1.1 carries the chain in
 *     `CompactionState.lastSummary/lastPointer` — `previousSummary` is
 *     null only on the FIRST compaction.
 *   - Slice 1.1 hardening: the evicted block is capped to 25% of the
 *     summarizer window before prompting (the store keeps the full
 *     text); a 5-minute cooldown rate-guards re-fires against estimate
 *     oscillation; the compaction result carries before/after/capped
 *     stats for Slice 2 logging.
 */

/** Fire threshold — fraction of the model window (spec: 75%). */
export const COMPACT_AT_RATIO = 0.75;
/** Post-compaction target / re-arm threshold — fraction of the window (spec: 40%). */
export const COMPACT_TARGET_RATIO = 0.4;
/** Recency token quota — fraction of the window (spec: 25%). */
export const RECENCY_WINDOW_RATIO = 0.25;
/** Recency turn floor — minimum number of recent turns kept verbatim (spec: 6). */
export const RECENCY_TURN_FLOOR = 6;
/** Rate-guard cooldown in ms — minimum spacing between two fires (spec slice 1.1: 5 minutes). */
export const COMPACT_COOLDOWN_MS = 300_000;
/** Evicted-block cap — fraction of the SUMMARIZER window the block may occupy (spec slice 1.1: 25%). */
export const EVICTED_CAP_RATIO = 0.25;
/** Retrieval budget — fraction of the model window a dereferenced block may occupy (spec slice 1.1: 10%). */
export const RETRIEVAL_BUDGET_RATIO = 0.1;

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
// Evicted-block cap + retrieval budget (slice 1.1)
// ---------------------------------------------------------------------------

/** Result of {@link capEvictedBlock}. */
export interface CappedBlock {
  /** The block as the summarizer may see it — uncapped, or head+tail with one omission marker. */
  text: string;
  /** `true` when the input exceeded the cap and was truncated. */
  capped: boolean;
  /** Token estimate of the ORIGINAL text (useful in stats even when uncapped). */
  originalTokens: number;
}

/** The single omission marker inserted at the cut (spec slice 1.1 wording). */
function omittedMarker(omittedChars: number): string {
  return `[… ${omittedChars} chars omitted, stored in full under pointer …]`;
}

/**
 * Caps an evicted block to `maxTokens` before it reaches the summarizer —
 * self-compaction loop protection: the cheap model has its own window and
 * must never be handed a block proportional to the MAIN window. Local and
 * deterministic (head + tail + one marker, zero LLM cost); the full text
 * still goes to the store — this cap applies ONLY to what the summarizer
 * sees. `maxTokens` is the cap itself (e.g. `evictedCapTokens(window)` or,
 * on the Slice 2 deref path, `retrievalBudgetTokens(window)`).
 */
export function capEvictedBlock(text: string, maxTokens: number, charsPerToken: number): CappedBlock {
  const originalTokens = estimateTokens(text.length, charsPerToken);
  if (originalTokens <= maxTokens) return { text, capped: false, originalTokens };

  const budgetChars = maxTokens * charsPerToken;
  // Reserve room for the marker at its widest (omitted <= text.length never
  // needs more digits), so head + marker + tail is guaranteed within budget.
  const reserve = omittedMarker(text.length).length;
  const keepBudget = Math.max(0, budgetChars - reserve);
  const half = Math.floor(keepBudget / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const omitted = text.length - head.length - tail.length;
  return { text: head + omittedMarker(omitted) + tail, capped: true, originalTokens };
}

/** Evicted-block cap in tokens for a given summarizer window (25%, floored). */
export function evictedCapTokens(summarizerWindowTokens: number): number {
  return Math.floor(EVICTED_CAP_RATIO * summarizerWindowTokens);
}

/**
 * Retrieval budget in tokens for a given model window (10%, floored).
 * Slice 2's deref path MUST pass retrieved blocks through
 * `capEvictedBlock` with this budget before injecting them.
 */
export function retrievalBudgetTokens(windowTokens: number): number {
  return Math.floor(RETRIEVAL_BUDGET_RATIO * windowTokens);
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
  /** Last checkpoint summary — the sliding-summary chain; absent/null until the first compaction (slice 1.1). */
  lastSummary?: string | null;
  /** Pointer to the last evicted block; absent/null until the first compaction (slice 1.1). */
  lastPointer?: string | null;
  /** Epoch-ms timestamp of the last fire; gates the cooldown rate guard (slice 1.1). */
  lastFiredAt?: number | null;
}

/**
 * Whether a compaction should fire now. Pure: the caller owns the
 * state transition (a `true` result means "fire", after which the
 * machine is discharged and must not fire again until re-armed).
 *
 * Rate guard (slice 1.1): when `state.lastFiredAt` is set and `nowMs`
 * is within `cooldownMs` of it, the fire is refused — protects the
 * summarizer quota against estimate oscillation bugs. `nowMs` defaults
 * to `Date.now()`; tests inject it for determinism. Exactly `cooldownMs`
 * elapsed counts as "after the cooldown" and is allowed.
 */
export function shouldCompact(
  state: CompactionState,
  usedTokens: number,
  windowTokens: number,
  nowMs?: number,
  cooldownMs: number = COMPACT_COOLDOWN_MS,
): boolean {
  if (!state.armed) return false;
  if (usedTokens < COMPACT_AT_RATIO * windowTokens) return false;
  const fired = state.lastFiredAt ?? null;
  if (fired !== null) {
    const now = nowMs ?? Date.now();
    if (now - fired < cooldownMs) return false;
  }
  return true;
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
 *
 * Slice 1.1: chain fields (`lastSummary`, `lastPointer`, `lastFiredAt`)
 * are carried through untouched — only `armed` is (re)evaluated.
 */
export function applyCompacted(
  state: CompactionState,
  usedTokensAfter: number,
  windowTokens: number,
): CompactionState {
  if (state.armed) return { ...state };
  return { ...state, armed: usedTokensAfter <= COMPACT_TARGET_RATIO * windowTokens };
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
  /** Summarizer window — when set, the evicted block is capped to 25% of it before prompting (slice 1.1). */
  summarizerWindowTokens?: number;
  /** Clock injection for the rate guard / `lastFiredAt` (defaults to `Date.now()`; tests inject it). */
  nowMs?: number;
}

/** Compaction statistics — Slice 2 logs these; Slice 1.1 tests assert them. */
export interface CompactionStats {
  /** Estimated usage before the fire. */
  beforeTokens: number;
  /** Estimated usage of the assembled (compacted) history. */
  afterTokens: number;
  /** Number of messages moved into the evicted block. */
  evictedMessages: number;
  /** Whether the evicted block was capped for the summarizer prompt. */
  capped: boolean;
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
  /** Stats on compaction, else `null` (slice 1.1). */
  stats: CompactionStats | null;
}

/**
 * Runs one compaction check over the message history.
 *
 * Flow: estimate usage (sum of per-message `estimateTokens(render(m))`)
 * → `shouldCompact`? no → passthrough (input copied, deps untouched).
 * yes → `splitZones` → empty evictable → passthrough (nothing to
 * compact). Otherwise: `store(evictable rendered)` — the FULL text,
 * the cap never applies to the store — → cap the block to 25% of
 * `summarizerWindowTokens` when provided (slice 1.1) →
 * `buildSummaryPrompt(state.lastSummary, cappedText)` (null only on
 * the first compaction) → `summarize` → assemble `[system...,
 * pinned..., summary-inject, recency...]` → evaluate the new
 * hysteresis state against the post-compaction usage and stamp the
 * chain (`lastSummary`/`lastPointer`/`lastFiredAt`) onto it.
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
  const nowMs = input.nowMs ?? Date.now();
  const estimate = (m: T): number => estimateTokens(render(m).length, charsPerToken);
  const usedTokens = messages.reduce((sum, m) => sum + estimate(m), 0);

  const passthrough = (): CompactionResult<T> => ({
    compacted: false,
    state,
    messages: [...messages],
    summary: null,
    pointer: null,
    stats: null,
  });

  if (!shouldCompact(state, usedTokens, windowTokens, nowMs)) return passthrough();

  const zones = splitZones(messages, windowTokens, estimate, isPinned);
  if (zones.evictable.length === 0) return passthrough();

  const evictedText = zones.evictable.map(render).join('\n\n');
  // Slice 1.1 chain: fold the previous checkpoint in — null only on the first compaction.
  const previousSummary = state.lastSummary ?? null;
  const previousPointer = state.lastPointer ?? null;
  let pointer: string;
  let summary: string;
  let capped = false;
  try {
    // Full text goes to the store — the cap below protects only the summarizer's window.
    pointer = await store.store(evictedText);
    let promptBlock = evictedText;
    if (input.summarizerWindowTokens !== undefined) {
      const cap = capEvictedBlock(evictedText, evictedCapTokens(input.summarizerWindowTokens), charsPerToken);
      promptBlock = cap.text;
      capped = cap.capped;
    }
    summary = await summarize(buildSummaryPrompt(previousSummary, promptBlock));
  } catch {
    return passthrough();
  }

  // Spec assembles the summary message as {role:'system', content: marker +
  // summary + pointer}. T is only constrained to {role}, so the literal is
  // cast — Slice 2 production callers use OpenAI-shaped messages where the
  // cast is exact. Slice 1.1: the pointer chain appends `previous pointer`
  // when a chain exists.
  const pointerChain = previousPointer === null ? '' : `\n[previous pointer: ${previousPointer}]`;
  const summaryMessage = {
    role: 'system',
    content: `${SUMMARY_MARKER}\n${summary}\n[evicted-block pointer: ${pointer}]${pointerChain}`,
  } as unknown as T;

  const assembled: T[] = [...zones.system, ...zones.pinned, summaryMessage, ...zones.recency];
  const usedAfter = assembled.reduce((sum, m) => sum + estimate(m), 0);
  // The fire discharged the machine above; evaluate re-arm against the
  // result while stamping the chain onto the state (slice 1.1).
  const firedState: CompactionState = {
    ...state,
    armed: false,
    lastSummary: summary,
    lastPointer: pointer,
    lastFiredAt: nowMs,
  };
  const nextState = applyCompacted(firedState, usedAfter, windowTokens);

  return {
    compacted: true,
    state: nextState,
    messages: assembled,
    summary,
    pointer,
    stats: {
      beforeTokens: usedTokens,
      afterTokens: usedAfter,
      evictedMessages: zones.evictable.length,
      capped,
    },
  };
}
