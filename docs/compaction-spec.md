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


## Slice 1.1 (spec amendment 2026-08-16 — gap fixes + hardening)

Two gaps found in Slice 1 self-review + three hardening additions. Core module only, same DI discipline.

### Gap 1 — evicted-block cap (self-compaction loop protection)

The summarizer (cheap model, own window) must never receive an evicted block larger than a fraction of ITS window.

- `capEvictedBlock(text: string, maxTokens: number, charsPerToken: number): { text: string; capped: boolean; originalTokens: number }`
- Cap = 25% of the SUMMARIZER window in tokens (caller passes its own window). Over-cap content: keep head + tail with a single `[… N chars omitted, stored in full under pointer …]` marker in the middle (local, deterministic, zero LLM cost). Full text still goes to the store — the cap applies ONLY to what the summarizer sees.
- `compactIfNeeded` gains optional `summarizerWindowTokens` + applies the cap before `buildSummaryPrompt`.

### Gap 2 — sliding summary chain (second compaction loses the first)

`CompactionState` extends to `{ armed: boolean; lastSummary: string | null; lastPointer: string | null }`.

- `compactIfNeeded` on success: `state.lastSummary = summary; state.lastPointer = pointer`, and `buildSummaryPrompt` receives `previousSummary = state.lastSummary` (null only on the FIRST compaction).
- The injected summary message now includes the pointer chain: current pointer + `previous pointer: <p>` line when present.

### Hardening 1 — rate guard

- `shouldCompact` signature extends: `shouldCompact(state, usedTokens, windowTokens, nowMs?, cooldownMs = 300_000)` — refuses to fire when `state.lastFiredAt` is within cooldown (protects quota against estimate oscillation bugs). `CompactionState.lastFiredAt: number | null`, set on fire.
- Default cooldown 5 minutes; tests: fire twice within cooldown → second refused; after cooldown → allowed.

### Hardening 2 — retrieval cap (constant for Slice 2 wiring)

- `export const RETRIEVAL_BUDGET_TOKENS = ...` computed as 10% of window; Slice 2 deref path MUST pass blocks through `capEvictedBlock` with this budget.

### Hardening 3 — compaction stats result

- `compactIfNeeded` result gains `stats: { beforeTokens: number; afterTokens: number; evictedMessages: number; capped: boolean } | null` (null when not compacted) — Slice 2 logs it; Slice 1 tests assert it.

### Slice 1.1 tests (extend test/unit/compaction.test.ts)

- capEvictedBlock: under cap passthrough; over cap → marker present, head+tail kept, capped=true.
- chain: two consecutive compactIfNeeded calls — second passes first summary into prompt (assert via fake summarizer capturing prompt), pointer chain line present.
- rate guard: within cooldown refused; after cooldown fires.
- stats: populated on compact, null on passthrough.
- backward compat: existing 21 tests keep passing (state shape change is additive; `armed` semantics unchanged).


## Slice 2 (spec 2026-08-16 — production wiring)

Everything below builds on the core module (commits 714aa02 + 27f6b39). Default OFF.

### Settings (package.json, scope application)

- `ollamaCloud.compaction.enabled` — boolean, default `false`.
- `ollamaCloud.compaction.model` — string, default `gpt-oss:20b`. Description states: cheap model used ONLY for context summarization, not for chat.

### New module `src/compactionStore.ts`

- `class CompactionStore { constructor(storageUri: vscode.Uri) }` — files under `<globalStorage>/compaction/`, name = sha256 hex of content + `.txt`.
- `async store(text: string): Promise<string>` — writes (idempotent: existing file → same pointer), returns pointer `ocp-compaction://<hash>`.
- `async resolve(pointer: string): Promise<string | null>` — validates the scheme, reads the file; null on unknown hash. NO traversal: reject pointers containing `/`, `..`, or non-hex chars.
- Retention: `async prune(keepCount = 200)` — delete oldest by mtime beyond keepCount; called opportunistically after each store.

### Summarizer `src/compactionSummarizer.ts`

- `function createSummarizer(deps: { request: (body: unknown) => Promise<string>; model: string; timeoutMs?: number }): Summarizer`
- `request` = a NON-STREAMING native `/api/chat` call via existing `httpRequest` (reuse the client's URL/auth/whitelist path — one small exported helper or a callback injected from provider). `stream: false`, `think: false` if supported; response `message.content`.
- Timeout default 60s via AbortController → throws (caller falls back). NEVER retries (single call per compaction event; rate guard already caps frequency).

### Provider integration (`src/provider.ts`)

- Per-conversation state: `Map<string, { armed: boolean; lastSummary: string|null; lastPointer: string|null; lastFiredAt: number|null }>` keyed by model id (per-model windows differ). Constructor-created.
- In `provideLanguageModelChatResponse`, BEFORE endpoint dispatch and BEFORE the context filter: if `compaction.enabled` → build render/estimate over `openaiMessages` (render = JSON.stringify message; estimate = charsPerTokenEMA per model) → `compactIfNeeded` with real summarizer + store. On `compacted:true` → REPLACE `openaiMessages` with result messages (the injected summary message is a `role:'system'` OpenAI message — flows through all 3 endpoints unchanged), log `logger.info('Compaction: before=X after=Y tokens evicted=N capped=Z pointer=P')`, emit ONE inline annotation via progress (`LanguageModelTextPart`: `🧠 Context compacted X→Y tokens`). On `compacted:false` → existing filter path untouched (fallback contract).
- Summarizer failure → log warn + proceed with UNCOMPACTED messages (filter path may still truncate — that is the accepted degradation).

### Tests

- compactionStore: store→resolve roundtrip; idempotent pointer; traversal rejected; prune keeps newest N. (Use vscode stub's storage or tmp dir via real fs — mirror how existing tests fake Uri/globalStorage; check test/_vscode-stub.mjs first and follow its pattern.)
- summarizer: fake `request` returns content; timeout path throws (use tiny timeoutMs); no retry on failure (count calls === 1).
- provider integration: compaction disabled → NO summarizer calls, messages unchanged; enabled + under threshold → passthrough; enabled + over threshold (fake huge messages, tiny window via model override or injected estimate) → messages replaced, summary-injected message present, annotation emitted, filter still applied afterwards on the COMPACTED list.
- Settings: defaults present in package.json (enabled=false, model=gpt-oss:20b).

### Out of scope (Slice 3+)

Retrieval/deref UI (pointer text only for now), pinning, GCW-side consumption, compaction of the summarizer's own context (cap handles it), CHANGELOG wording beyond [Unreleased] bullet.
