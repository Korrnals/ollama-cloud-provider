# Compaction Spec — v0.13.0 Slice 1 (core module)

Status: implementing. Decisions closed 2026-08-16 (mnemos CCR 536604de; owner override retained).
Scope of THIS slice: pure core module + unit tests. NO provider wiring, NO settings, NO real summarizer (DI only). Slice 2 wires production.

## Decisions (binding)

1. Summary model: cheap cloud (default `gpt-oss:20b`, configurable later); fallback on unavailability = degrade to existing blunt truncation, never fail the chat. (Slice 2 concern — module must make fallback possible.)
2. Hysteresis: compact at **75%** of model window → down to **40%**. Re-arm: next compaction fires again only at 75%.
3. Recency window: **25% of window in tokens**, floor **6 turns** (turn = one user request + everything through the next user request). Cut boundary: ONLY between complete tool_call/tool_result pairs, never inside.
4. Self-sufficiency: extension-local store, zero external dependencies (no mnemos).

## Module: `src/compaction.ts`

DI everything (sinon cannot stub ESM — same reason as ssrfGuard.ts):

```typescript
// Token estimation
export function estimateTokens(chars: number, charsPerToken: number): number;

// Hysteresis state machine (pure)
export interface CompactionState { armed: boolean; }
export function shouldCompact(state: CompactionState, usedTokens: number, windowTokens: number): boolean;
// armed=true → fire at >=75%; on fire → armed=false; re-arm at <=40% after compaction result applied.
export function applyCompacted(state: CompactionState, usedTokensAfter: number, windowTokens: number): CompactionState;

// Zone split
export interface ContextZones<T> {
  system: T[];              // all system messages, verbatim, never compacted
  pinned: T[];              // messages marked pinned (see below), verbatim
  evictable: T[];           // candidates for summarization
  recency: T[];             // verbatim recent turns
}
export function splitZones<T extends { role: string }>(
  messages: readonly T[],
  windowTokens: number,
  estimate: (m: T) => number,
): ContextZones<T>;
// recency = take from END: >= 25% of window in tokens OR >= 6 turns (whichever LARGER by coverage; if 6 turns exceed 25%, take 6 turns anyway), boundary adjusted to nearest tool-pair gap (never split assistant-tool_call ... tool-result).
// pinned: role-preserved marker — Slice 1: treat NO messages as pinned (empty array) but keep the field + a `isPinned?: (m:T)=>boolean` param defaulting to ()=>false, so Slice 2+ can mark decisions/invariants.

// Sliding summary
export function buildSummaryPrompt(previousSummary: string | null, evictedBlockText: string): string;
// Incremental: summarize(previous + ONLY the new evicted block). Prompt demands checkpoint shape:
// Goal (first line, restated), Done, Decisions, Open threads, Turn range. Machine-generated marker.

// Summarizer + store contracts (production impl = Slice 2)
export type Summarizer = (prompt: string) => Promise<string>;
export type EvictedStore = { store(blockText: string): Promise<string> }; // returns pointer

// Orchestration (pure w.r.t. inputs; async only via injected deps)
export async function compactIfNeeded<T extends { role: string }>(input: {
  messages: readonly T[];
  windowTokens: number;
  charsPerToken: number;
  state: CompactionState;
  summarize: Summarizer;      // tests: fake; slice 2: cheap-model client
  store: EvictedStore;        // tests: fake; slice 2: local file store
  render: (m: T) => string;   // message → text for store/prompt
  isPinned?: (m: T) => boolean;
}): Promise<{ compacted: boolean; state: CompactionState; messages: T[]; summary: string | null; pointer: string | null }>;
// Flow: estimate → shouldCompact? no → passthrough. yes → splitZones → if evictable empty → passthrough (nothing to compact).
// store(evictable rendered) → buildSummaryPrompt(prevSummary??stored?, evictedText) — Slice 1: previousSummary passed as null from orchestrator; the STORED chain is slice 2.
// → summarize → assemble: [system..., pinned..., {role:'system', content: SUMMARY_MARKER+summary+POINTER}, recency...]
// If summarize throws → return passthrough + compacted:false (fallback contract; caller later falls back to truncation path).
```

`SUMMARY_MARKER` = `[compacted-turns ...]` prefix incl. machine-generated marker text.

## Tests (`test/unit/compaction.test.ts`)

- estimateTokens basic math.
- shouldCompact: not before 75%; at 75% fires once; stays disarmed until <=40%.
- splitZones: recency >= 25% tokens; 6-turn floor when tokens small; tool-pair never split (synthetic pair at boundary); system always in system zone; pinned respected via predicate.
- buildSummaryPrompt: contains Goal-first instruction, previous summary included when present.
- compactIfNeeded: below threshold → passthrough, compacted:false; above → zones assembled in order [system,pinned,summary-inject,recency], pointer returned, state disarmed; summarizer throw → passthrough + compacted:false.

## Constraints

- `npx tsc` 0; `npm run lint` 0; `npm test` 0 failing (582 + new).
- No vscode import inside compaction.ts (pure module — vscode wiring is Slice 2).
- One semantic commit: `feat(compaction): core module — zones, hysteresis, sliding summary (DI)`.
