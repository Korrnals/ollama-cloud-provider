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
 *   - v0.21.0 (slice d1, stickiness): VS Code re-sends the FULL
 *     immutable chat history on every request, so a compaction that
 *     only rewrote the triggering request evaporates on the next one
 *     (field evidence 2026-10-02: context whiplash 380K↔1.1M tokens
 *     between consecutive turns). After a fire, the projection
 *     (system + pinned + injected summary replacing the evicted
 *     prefix) is remembered in `CompactionState.projection` keyed by
 *     a fingerprint of the consumed raw prefix, and RE-APPLIED to
 *     every subsequent request whose history still starts with that
 *     prefix (tail growth allowed). The cooldown and the 75%
 *     threshold gate NEW summarizer fires only — never the
 *     re-application of an existing projection.
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
// Projection fingerprints (v0.21.0 slice d1 — stickiness)
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a fingerprint of a rendered message, hex-encoded. Used to
 * recognize the consumed raw-history prefix across requests WITHOUT
 * holding the full (multi-megabyte) prefix text in memory. This is a
 * correctness guard for a UI state machine, not a security boundary:
 * element-wise comparison of one fingerprint per prefix message plus the
 * length guard makes accidental collisions negligible for real chat
 * traffic, and a false match can only serve a stale-but-valid-shaped
 * projection for one request.
 */
export function fingerprintText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Whether `messages` still starts with the remembered prefix basis and
 * has grown beyond it (a projection replaces a prefix; an incoming
 * history at or below the basis length cannot be a continuation).
 * Pure; any `render` error propagates to the caller's safety net.
 */
function basisMatches<T>(
  messages: readonly T[],
  basis: readonly string[],
  render: (m: T) => string,
): boolean {
  if (messages.length <= basis.length) return false;
  for (let i = 0; i < basis.length; i++) {
    if (fingerprintText(render(messages[i]!)) !== basis[i]) return false;
  }
  return true;
}

/**
 * The remembered compaction projection (v0.21.0 slice d1). After a fire,
 * `compactIfNeeded` remembers what the fire REPLACED and what it served,
 * so subsequent requests re-apply the compacted shape instead of
 * passing the raw history through (VS Code re-sends the full immutable
 * history every turn — see the module header).
 *
 * - `basis`: fingerprint (via {@link fingerprintText} over `render`) of
 *   every message of the consumed raw prefix, in order. Validity check
 *   on each request: the incoming history must still start with exactly
 *   this prefix and be longer than it (tail growth is the normal case).
 * - `head` + `summaryMessage`: what is served in place of that prefix —
 *   `[system..., pinned..., summary-inject]`. The pinned predicate must
 *   be stable across calls for stickiness to carry pinned messages; a
 *   member that loses pinned status is not re-carried (production
 *   currently pins nothing, so this constraint is dormant).
 */
export interface CompactionProjection<T> {
  /** Fingerprints of the consumed raw prefix messages, in order. */
  basis: string[];
  /** Consumed-and-carried messages: `[system..., pinned...]` carved from the raw basis region. */
  head: T[];
  /** The machine-generated summary message injected in place of the evicted block. */
  summaryMessage: T;
}

// ---------------------------------------------------------------------------
// Hysteresis state machine
// ---------------------------------------------------------------------------

/**
 * Compaction hysteresis state. `armed: true` means the machine will fire
 * when usage reaches {@link COMPACT_AT_RATIO}; a fire sets `armed: false`
 * until {@link applyCompacted} observes the result at or below
 * {@link COMPACT_TARGET_RATIO}.
 *
 * Generic in the message type because the d1 projection carries message
 * references; defaults to `unknown` so non-generic uses (hysteresis-only
 * checks) compile unchanged.
 */
export interface CompactionState<T = unknown> {
  armed: boolean;
  /** Last checkpoint summary — the sliding-summary chain; absent/null until the first compaction (slice 1.1). */
  lastSummary?: string | null;
  /** Pointer to the last evicted block; absent/null until the first compaction (slice 1.1). */
  lastPointer?: string | null;
  /** Epoch-ms timestamp of the last fire; gates the cooldown rate guard (slice 1.1). */
  lastFiredAt?: number | null;
  /**
   * Remembered projection for stickiness (v0.21.0 slice d1); absent/null
   * when no compaction is currently projected. Dropped (with the summary
   * chain) as soon as the incoming history stops matching the basis.
   */
  projection?: CompactionProjection<T> | null;
}

/**
 * Whether a compaction should fire now. Pure: the caller owns the
 * state transition (a `true` result means "fire", after which the
 * machine is discharged and must not fire again until re-armed).
 *
 * Unknown-window safe path (ArchCom 2026-09-15, invariant 4): when
 * `windowTokens` is missing or non-positive the hysteresis has no
 * denominator — 75% of 0/undefined is meaningless, and an arbitrary
 * zone split would evict context against a nonsense threshold. The
 * machine NEVER fires without a known window.
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
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return false;
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
 * A discharged (disarmed) machine re-arms when the post-compaction
 * usage is at or below the fire threshold (75%). The original spec
 * required reaching the 40% target, but that created a
 * stuck-disarmed failure mode: if a compaction could not reach 40%
 * (e.g. the summarizer returned a long summary, or the recency tail
 * itself is large), the machine stayed disarmed forever and
 * compaction never fired again — context grew unbounded.
 *
 * Fix 2026-08-19 (Bug 1 RCA): re-arm when `usedTokensAfter <=
 * COMPACT_AT_RATIO * windowTokens` (75%). This still prevents
 * immediate re-fire (the cooldown guard in `shouldCompact` enforces
 * the 5-minute gap), but allows recovery from a partial compaction.
 * Reaching the 40% target is the happy path; the 75% threshold is the
 * recovery path.
 *
 * Evaluating an armed machine never disarms it — only a fire discharges.
 *
 * Slice 1.1: chain fields (`lastSummary`, `lastPointer`, `lastFiredAt`)
 * are carried through untouched — only `armed` is (re)evaluated.
 * v0.21.0 d1: the projection rides along in the spread; the function is
 * generic so the carried message type survives the copy.
 */
export function applyCompacted<T>(
  state: CompactionState<T>,
  usedTokensAfter: number,
  windowTokens: number,
): CompactionState<T> {
  if (state.armed) return { ...state };
  // Bug 1 fix — re-arm at the fire threshold (75%), not just the
  // target (40%). A partial compaction that did not reach 40% but
  // dropped below 75% should re-arm so the next fire can attempt
  // another compaction (with the cooldown guard preventing loops).
  return { ...state, armed: usedTokensAfter <= COMPACT_AT_RATIO * windowTokens };
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

  // Cap the turn floor so it cannot dominate when tokens are the binding
  // constraint. In agent sessions with few user turns but many tool
  // results (e.g. 5 user + 300 tool, 129K tokens), the 6-turn floor
  // would otherwise span ALL candidates → evictable empty → compaction
  // no-ops → 400 context-too-long from the server. The token-based
  // quota wins when 6 turns = the whole conversation and it's over
  // budget; turns may extend the token floor up to 2× for safety, but
  // never dominate it.
  const cappedByTurns = Math.min(byTurns, byTokens * 2);
  let count = Math.min(candidates.length, Math.max(byTokens, cappedByTurns));
  let recency = candidates.slice(candidates.length - count);
  let evictable = candidates.slice(0, candidates.length - count);

  // Emergency fallback: if nothing is evictable but the conversation is
  // over the hard window limit, force-evict the oldest 10% of candidates
  // regardless. This prevents the "nothing to evict but context too
  // long" deadlock — a last-resort truncation that lets compaction
  // proceed instead of no-oping into a server 400.
  if (evictable.length === 0 && candidates.length > 0) {
    const totalUsed = candidates.reduce((s, m) => s + estimate(m), 0);
    if (totalUsed > windowTokens) {
      const evictCount = Math.max(1, Math.floor(candidates.length * 0.1));
      evictable = candidates.slice(0, evictCount);
      recency = candidates.slice(evictCount);
    }
  }

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
  state: CompactionState<T>;
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
  /** v0.21.0 d1 — `true` when `messages` is a re-applied remembered projection (no new fire this call). */
  reapplied: boolean;
  /** v0.21.0 d1 — `true` when a remembered projection was dropped this call (basis mismatch or re-apply error). */
  droppedProjection: boolean;
  /** Post-check hysteresis state (input state on plain passthrough; carries projection transitions otherwise). */
  state: CompactionState<T>;
  /** Messages to send onward: input copy on passthrough, projection shape on compaction/re-apply. */
  messages: T[];
  /** Checkpoint text on compaction, else `null`. */
  summary: string | null;
  /** Evicted-store pointer on compaction, else `null`. */
  pointer: string | null;
  /** Stats on compaction, else `null` (slice 1.1). */
  stats: CompactionStats | null;
  /** v0.21.0 d1 — re-apply observability; `null` unless this call re-applied a projection. */
  reapply: { projectedTokens: number; tailMessages: number } | null;
}

/**
 * Drops a remembered projection and the summary chain it anchors (v0.21.0
 * d1 invalidation). `lastFiredAt` is kept so the cooldown still rate-guards
 * the fresh machine; `armed` is restored — a projection exists only after a
 * fire, and re-arming on invalidation avoids the stuck-disarmed failure
 * mode (the history that invalidated the basis never re-evaluates a fire
 * result, so nothing else would re-arm the machine).
 */
function resetProjection<T>(state: CompactionState<T>): CompactionState<T> {
  return {
    armed: true,
    lastSummary: null,
    lastPointer: null,
    lastFiredAt: state.lastFiredAt ?? null,
    projection: null,
  };
}

/**
 * Runs one compaction check over the message history.
 *
 * Flow (v0.21.0 d1): estimate raw usage → when a projection is
 * remembered, check the basis against the incoming history:
 *   - basis matches (prefix intact, history grown) → RE-APPLY: serve
 *     `[head..., summary-inject, tail...]` where the tail is the raw
 *     history beyond the basis. Re-application is independent of the
 *     cooldown and the 75% threshold — those gate NEW fires only.
 *   - basis gone (new session, VS Code-side pruning, deleted turns) →
 *     drop the projection AND the summary chain (a stale chain would
 *     fold an unrelated conversation into the next summary), keep the
 *     cooldown stamp, restore `armed`.
 * Then run the hysteresis over the EFFECTIVE (re-applied when sticky)
 * history: `shouldCompact`? no → serve the effective history (re-applied
 * projection, or input copy on plain passthrough). yes → `splitZones` →
 * empty evictable → serve effective. Otherwise: `store(evictable
 * rendered)` — the FULL text, the cap never applies to the store — →
 * cap the block to 25% of `summarizerWindowTokens` when provided
 * (slice 1.1) → `buildSummaryPrompt(state.lastSummary, cappedText)`
 * (null only on the first compaction) → `summarize` → assemble
 * `[system..., pinned..., summary-inject, recency...]` → evaluate the
 * new hysteresis state against the post-compaction usage, stamp the
 * chain, and remember the NEW projection (fingerprints of the consumed
 * raw prefix + the head served in its place).
 *
 * Fallback contract (spec decision 1): if `store` or `summarize`
 * throws, the history is passed through untouched with
 * `compacted: false` — compaction never fails the chat; the caller
 * falls back to the existing blunt truncation path. d1 extension: a
 * failed re-fire still serves the re-applied projection (better than
 * raw), and any error inside the re-apply path itself degrades to the
 * raw passthrough.
 */
export async function compactIfNeeded<T extends { role: string }>(
  input: CompactIfNeededInput<T>,
): Promise<CompactionResult<T>> {
  const { messages, windowTokens, charsPerToken, state, summarize, store, render } = input;
  const isPinned = input.isPinned ?? (() => false);
  const nowMs = input.nowMs ?? Date.now();
  const estimate = (m: T): number => estimateTokens(render(m).length, charsPerToken);
  const usedTokens = messages.reduce((sum, m) => sum + estimate(m), 0);

  // --- d1 stickiness: re-apply a remembered projection while the raw
  // history still carries the evicted prefix basis. `effective` is what
  // the model should see this request and what a new fire operates on.
  let effective: readonly T[] = messages;
  let effectiveUsed = usedTokens;
  let reapplied = false;
  let droppedProjection = false;
  let tailMessages = 0;
  let working: CompactionState<T> = state;
  const projection = state.projection ?? null;
  if (projection !== null) {
    let basisOk = false;
    try {
      basisOk = basisMatches(messages, projection.basis, render);
    } catch {
      basisOk = false;
    }
    if (basisOk) {
      try {
        effective = [...projection.head, projection.summaryMessage, ...messages.slice(projection.basis.length)];
        tailMessages = messages.length - projection.basis.length;
        effectiveUsed = effective.reduce((sum, m) => sum + estimate(m), 0);
        reapplied = true;
      } catch {
        // SAFETY (fallback contract): any error in the re-apply path
        // degrades to the uncompacted raw passthrough — never fails
        // the chat, never keeps a half-applied projection.
        effective = messages;
        effectiveUsed = usedTokens;
        working = resetProjection(state);
        droppedProjection = true;
      }
    } else {
      working = resetProjection(state);
      droppedProjection = true;
    }
  }

  const passthrough = (): CompactionResult<T> => ({
    compacted: false,
    reapplied,
    droppedProjection,
    state: working,
    messages: [...effective],
    summary: null,
    pointer: null,
    stats: null,
    reapply: reapplied ? { projectedTokens: effectiveUsed, tailMessages } : null,
  });

  // Re-evaluate the hysteresis against the SERVED (re-applied) usage:
  // applyCompacted is otherwise only evaluated on fires, so a machine
  // discharged by a partial compaction would stay disarmed forever
  // while the tail grows. Armed machines are never disarmed here.
  if (reapplied) {
    working = applyCompacted(working, effectiveUsed, windowTokens);
  }

  if (!shouldCompact(working, effectiveUsed, windowTokens, nowMs)) return passthrough();

  const zones = splitZones(effective, windowTokens, estimate, isPinned);
  if (zones.evictable.length === 0) return passthrough();

  const evictedText = zones.evictable.map(render).join('\n\n');
  // Slice 1.1 chain: fold the previous checkpoint in — null only on the
  // first compaction (or after a d1 invalidation reset).
  const previousSummary = working.lastSummary ?? null;
  const previousPointer = working.lastPointer ?? null;
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

  // d1: on a re-fire the effective history opened with the previous
  // projection; its injected summary message is REPLACED by the chained
  // summary above — drop exactly that one message (by identity; raw-tail
  // messages are fresh objects each request, so identity can never
  // false-positive on them) so the assembled list never carries two
  // summary messages.
  const oldSummary = reapplied ? projection!.summaryMessage : null;
  const systemKept = oldSummary !== null ? zones.system.filter((m) => m !== oldSummary) : zones.system;
  const assembled: T[] = [...systemKept, ...zones.pinned, summaryMessage, ...zones.recency];
  const usedAfter = assembled.reduce((sum, m) => sum + estimate(m), 0);

  // d1: remember the new projection — fingerprints of the raw prefix the
  // projection replaces (in RAW coordinates, because VS Code re-sends the
  // raw history, never our projection) and the head served in its place.
  // The accounting maps the surviving zones back onto the raw message
  // stream: survivors (kept pinned + recency) must form a contiguous raw
  // suffix. When they do not (a pinned/system message interleaves inside
  // the evicted span — production pins nothing and front-loads system
  // messages, so this is a degenerate-history path), stickiness is
  // skipped for this fire (projection: null) rather than serving a wrong
  // projection later.
  const sticky = projection !== null && reapplied;
  const rawTail: T[] = sticky ? [...messages.slice(projection!.basis.length)] : [...messages];
  const prevBasis: string[] = sticky ? [...projection!.basis] : [];
  const survivor = new Set<T>([...zones.pinned, ...zones.recency]);
  let contiguous = true;
  let consumedPrefix = 0;
  let seenSurvivor = false;
  for (const m of rawTail) {
    if (survivor.has(m)) {
      seenSurvivor = true;
    } else if (seenSurvivor) {
      contiguous = false;
      break;
    } else {
      consumedPrefix++;
    }
  }
  let newBasis: string[] | null = null;
  if (contiguous) {
    try {
      newBasis = [...prevBasis];
      for (let i = 0; i < consumedPrefix; i++) {
        newBasis.push(fingerprintText(render(rawTail[i]!)));
      }
    } catch {
      newBasis = null;
    }
  }
  // Head members carried forward: fresh system messages plus pinned
  // messages that came from the previous head (tail-region pinned
  // messages survive at their raw position and must NOT be carried —
  // that would duplicate them).
  const oldHeadSet = sticky ? new Set(projection!.head) : null;
  const nextHead: T[] = [
    ...systemKept,
    ...(oldHeadSet !== null ? zones.pinned.filter((m) => oldHeadSet.has(m)) : []),
  ];

  // The fire discharged the machine above; evaluate re-arm against the
  // result while stamping the chain onto the state (slice 1.1).
  const firedState: CompactionState<T> = {
    ...working,
    armed: false,
    lastSummary: summary,
    lastPointer: pointer,
    lastFiredAt: nowMs,
    projection: newBasis !== null ? { basis: newBasis, head: nextHead, summaryMessage } : null,
  };
  const nextState = applyCompacted(firedState, usedAfter, windowTokens);

  return {
    compacted: true,
    reapplied: false,
    droppedProjection,
    state: nextState,
    messages: assembled,
    summary,
    pointer,
    stats: {
      beforeTokens: effectiveUsed,
      afterTokens: usedAfter,
      evictedMessages: zones.evictable.length,
      capped,
    },
    reapply: null,
  };
}
