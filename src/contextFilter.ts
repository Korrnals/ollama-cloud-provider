// ADR 0007 — Context filtering (pre-model payload processing).
//
// Pure functions. No network, no I/O, no side effects, no `Date.now()`,
// no module-level mutable state, no `logger` calls. Given the same
// input, `filterContext` always returns the same output. The provider
// reads the `ContextFilterReport` and emits the log lines — the filter
// itself never logs (preserves the "pure functions, no side effects"
// contract from ADR 0007 § Module contract).
//
// Three levels (`off` / `safe` / `aggressive`), configured globally with
// a per-connection override (resolved by the provider BEFORE calling
// `filterContext`). `off` is a fast path: the provider does NOT call
// `filterContext` at `off` (zero overhead). When called with `off`
// directly, `filterContext` still returns the input unchanged with an
// empty report — defensive, but the provider's fast path is the
// primary guarantee.
//
// Tool-call integrity (ADR § Tool-call integrity) is a binding rule
// enforced after every drop and every merge: a dropped `tool_call`
// always drops its matching `tool_call_output` and vice versa. The
// helper `enforceToolCallIntegrity` is called after each mutating step
// so the output NEVER contains an orphaned `tool_call_output` or a
// `tool_call` with no output.
//
// Vision content (`image_url` parts) is NEVER filtered, dropped, or
// compacted at any level (ADR § Non-goals). Duplicate detection
// compares `image_url` parts by reference identity, not by base64
// bytes — two distinct image attachments are NOT duplicates even when
// the bytes match.
//
// Zero new runtime dependencies (ADR 0001). The Jaccard similarity used
// by `aggressive` message merging is a few lines of TypeScript below.
// The char-based token proxy reuses `countOpenAIRequestChars` from
// `convert.ts` — no tokenizer.
import { countOpenAIRequestChars } from './convert.js';
import type {
  OpenAICompatibleMessage,
  OpenAICompatibleTool,
  OpenAIContentPart,
} from './protocolTypes.js';

/** ADR 0007 — user-selected filter level (global setting + per-connection override). */
export type ContextFilterLevel = 'off' | 'safe' | 'aggressive';

/** ADR 0007 — per-connection override value; `auto` inherits the global level. */
export type ConnectionContextFilterLevel = ContextFilterLevel | 'auto';

/** ADR 0007 — `CHARS_PER_TOKEN` proxy for the char-based token estimate. */
const CHARS_PER_TOKEN = 4;

/** ADR 0007 — safety margin so a char-proxy under-estimate does not push the real token count over the model limit. */
const TRUNCATION_SAFETY_MARGIN = 0.9;

/** ADR 0007 — Jaccard similarity threshold for `aggressive` adjacent-message merging. */
const MERGE_JACCARD_THRESHOLD = 0.8;

/** Recognised structural keys of an `OpenAICompatibleMessage` (ADR § aggressive metadata strip). */
const RECOGNISED_MESSAGE_KEYS = new Set([
  'role',
  'content',
  'tool_calls',
  'tool_call_id',
  'name',
  'refusal',
]);

/**
 * ADR 0007 — report carrying the counts and items needed for the
 * provider's log line. Every field is populated by `filterContext` so
 * the provider can emit both the summary line and the per-class
 * diagnostics without re-scanning the output.
 */
export interface ContextFilterReport {
  level: ContextFilterLevel;
  beforeChars: number;
  afterChars: number;
  droppedMessages: number;
  droppedTools: number;
  mergedMessages: number;
  compactedSystemPrompt: boolean;
  truncatedMessages: number;
  strippedMetadataFields: number;
}

/** Input to `filterContext`. All fields are read-only; the filter does not mutate them. */
export interface ContextFilterInput {
  messages: readonly OpenAICompatibleMessage[];
  tools: readonly OpenAICompatibleTool[] | undefined;
  level: ContextFilterLevel;
  /** Used by `aggressive` truncation: `maxInputTokens * 0.9 * CHARS_PER_TOKEN` chars. */
  maxInputTokens: number;
}

/** Output of `filterContext`. New arrays; the caller's input is not mutated. */
export interface ContextFilterResult {
  messages: OpenAICompatibleMessage[];
  tools: OpenAICompatibleTool[] | undefined;
  report: ContextFilterReport;
}

/**
 * ADR 0007 — filters and compacts the request payload before the
 * convert step. Pure: no network, no I/O, no side effects. The
 * provider resolves the effective level and calls this only for
 * `safe` / `aggressive` (the `off` fast path skips the call entirely).
 */
export function filterContext(input: ContextFilterInput): ContextFilterResult {
  const beforeChars = countOpenAIRequestChars(input.messages);

  if (input.level === 'off') {
    return {
      // Copy the arrays so the caller's input is never aliased into
      // the output — preserves the "no side effects on the input"
      // contract even at `off`.
      messages: [...input.messages],
      tools: input.tools === undefined ? undefined : [...input.tools],
      report: {
        level: 'off',
        beforeChars,
        afterChars: beforeChars,
        droppedMessages: 0,
        droppedTools: 0,
        mergedMessages: 0,
        compactedSystemPrompt: false,
        truncatedMessages: 0,
        strippedMetadataFields: 0,
      },
    };
  }

  // `safe` runs first (both `safe` and `aggressive` include it).
  const safeResult = applySafe(input.messages, input.tools);
  let messages = safeResult.messages;
  let tools = safeResult.tools;
  let droppedMessages = safeResult.droppedMessages;
  let droppedTools = safeResult.droppedTools;
  let compactedSystemPrompt = safeResult.compactedSystemPrompt;

  let mergedMessages = 0;
  let truncatedMessages = 0;
  let strippedMetadataFields = 0;

  if (input.level === 'aggressive') {
    const trunc = applyTruncation(messages, input.maxInputTokens);
    messages = trunc.messages;
    truncatedMessages += trunc.truncated;
    messages = enforceToolCallIntegrity(messages);

    const merge = applyMerge(messages);
    messages = merge.messages;
    mergedMessages += merge.merged;
    messages = enforceToolCallIntegrity(messages);

    const strip = applyMetadataStrip(messages);
    messages = strip.messages;
    strippedMetadataFields += strip.strippedFields;
  }

  const afterChars = countOpenAIRequestChars(messages);

  return {
    messages,
    tools,
    report: {
      level: input.level,
      beforeChars,
      afterChars,
      droppedMessages,
      droppedTools,
      mergedMessages,
      compactedSystemPrompt,
      truncatedMessages,
      strippedMetadataFields,
    },
  };
}

// ---------------------------------------------------------------------------
// `safe` level — structural cleanup, no message removal (except empties).
// ---------------------------------------------------------------------------

interface SafeResult {
  messages: OpenAICompatibleMessage[];
  tools: OpenAICompatibleTool[] | undefined;
  droppedMessages: number;
  droppedTools: number;
  compactedSystemPrompt: boolean;
}

function applySafe(
  inputMessages: readonly OpenAICompatibleMessage[],
  inputTools: readonly OpenAICompatibleTool[] | undefined,
): SafeResult {
  let compactedSystemPrompt = false;
  let droppedMessages = 0;

  // Dedup messages by full structural equality (same role + identical
  // content + identical tool_calls + identical tool_call_id). First
  // occurrence wins. Tool-call-bearing messages are included in dedup
  // — a true duplicate assistant-with-tool_calls is dropped, and
  // `enforceToolCallIntegrity` (called after) drops the matching tool
  // outputs. This extends the ADR's "same role AND identical content"
  // to include tool_calls/tool_call_id so two assistant tool-call
  // messages with null content but different calls are NOT treated as
  // duplicates.
  const seen: OpenAICompatibleMessage[] = [];
  const deduped: OpenAICompatibleMessage[] = [];
  for (const message of inputMessages) {
    let isDuplicate = false;
    for (const prior of seen) {
      if (messagesEqual(prior, message)) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      droppedMessages++;
      continue;
    }
    seen.push(message);
    deduped.push(message);
  }

  // Empty-content-part removal + whitespace trim + system-prompt
  // compaction. Build new message objects so the input is never
  // mutated.
  const cleaned: OpenAICompatibleMessage[] = [];
  for (const message of deduped) {
    const cleanedContent = cleanContent(message);
    const role = message.role;

    // System-prompt compaction: collapse whitespace runs into a single
    // space and trim. Applied to string content and to `text` parts of
    // part-array content. Non-system messages are NOT compacted at
    // `safe` (a user's deliberate formatting in a code block must
    // survive `safe`).
    if (role === 'system') {
      const compacted = compactSystemContent(cleanedContent.content);
      if (compacted.changed) {
        compactedSystemPrompt = true;
      }
      cleanedContent.content = compacted.value;
    }

    // Drop the message if it has no content (and no tool_calls /
    // tool_call_id). Empty assistant turns with only tool_calls are
    // kept (tool_calls carry the payload).
    if (
      isEmptyContent(cleanedContent.content) &&
      (message.tool_calls === undefined || message.tool_calls.length === 0) &&
      message.tool_call_id === undefined
    ) {
      droppedMessages++;
      continue;
    }

    cleaned.push({
      role,
      content: cleanedContent.content,
      ...(message.tool_calls !== undefined && message.tool_calls.length > 0
        ? { tool_calls: message.tool_calls }
        : {}),
      ...(message.tool_call_id !== undefined
        ? { tool_call_id: message.tool_call_id }
        : {}),
      ...(message.reasoning_content !== undefined
        ? { reasoning_content: message.reasoning_content }
        : {}),
      // ADR 0007 — `name` and `refusal` are recognised keys that
      // survive `safe`. They are stripped only at `aggressive` (see
      // `applyMetadataStrip`). Spreading them here preserves the
      // safe-level invariant; the aggressive step later strips the
      // non-essential ones and counts them in the report.
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.refusal !== undefined ? { refusal: message.refusal } : {}),
    });
  }

  let messagesAfterDedup = enforceToolCallIntegrity(cleaned);
  // `enforceToolCallIntegrity` may drop additional messages (orphaned
  // tool outputs after a duplicate assistant was dropped). Those drops
  // are integrity-driven, not dedup-driven — count them as dropped
  // messages so the report's `droppedMessages` reflects the total
  // messages removed at `safe`.
  const integrityDropped = cleaned.length - messagesAfterDedup.length;
  if (integrityDropped > 0) {
    droppedMessages += integrityDropped;
  }

  // Dedup tools by `function.name`. First definition wins. An empty
  // input tool array yields `undefined` (mirrors `convertToolsToOpenAI`
  // / `convertToolsToResponses` so downstream request bodies omit the
  // `tools` field entirely when there are no tools).
  let droppedTools = 0;
  let tools: OpenAICompatibleTool[] | undefined;
  if (inputTools !== undefined && inputTools.length > 0) {
    const seenNames = new Set<string>();
    const dedupedTools: OpenAICompatibleTool[] = [];
    for (const tool of inputTools) {
      const name = tool.function.name;
      if (seenNames.has(name)) {
        droppedTools++;
        continue;
      }
      seenNames.add(name);
      dedupedTools.push(tool);
    }
    tools = dedupedTools;
  }

  return {
    messages: messagesAfterDedup,
    tools,
    droppedMessages,
    droppedTools,
    compactedSystemPrompt,
  };
}

// ---------------------------------------------------------------------------
// `aggressive` step 1 — truncate oldest messages to fit the char budget.
// ---------------------------------------------------------------------------

interface TruncationResult {
  messages: OpenAICompatibleMessage[];
  truncated: number;
}

function applyTruncation(
  messages: readonly OpenAICompatibleMessage[],
  maxInputTokens: number,
): TruncationResult {
  const budget = Math.floor(maxInputTokens * TRUNCATION_SAFETY_MARGIN * CHARS_PER_TOKEN);
  if (budget <= 0) {
    return { messages: [...messages], truncated: 0 };
  }

  // Preserve the system prompt (first `role:system` message) and the
  // last `role:user` message unconditionally (ADR § aggressive).
  const systemIndex = messages.findIndex((m) => m.role === 'system');
  const lastUserIndex = findLastIndex(messages, (m) => m.role === 'user');
  const preserve = new Set<number>();
  if (systemIndex !== -1) {
    preserve.add(systemIndex);
  }
  if (lastUserIndex !== -1) {
    preserve.add(lastUserIndex);
  }

  let current = [...messages];
  let truncated = 0;

  // Drop from the front (after the system prompt) until under budget.
  // Candidates are indices >= the position right after the system
  // prompt (or 0 when there is no system prompt), in ascending order,
  // excluding preserved indices. We drop one at a time, recompute the
  // char count, and stop when under budget or no candidates remain.
  const startSearch = systemIndex === -1 ? 0 : systemIndex + 1;
  while (countOpenAIRequestChars(current) > budget) {
    let dropIndex = -1;
    for (let i = startSearch; i < current.length; i++) {
      if (preserve.has(i)) {
        continue;
      }
      dropIndex = i;
      break;
    }
    if (dropIndex === -1) {
      break; // no droppable message left
    }
    current.splice(dropIndex, 1);
    truncated++;
    // Re-index preserved positions. The system prompt is before
    // `startSearch`, so its index is unaffected by drops at
    // `startSearch+`. The last user message is typically near the end;
    // a drop before it shifts its index down by one. Recompute it.
    if (lastUserIndex !== -1) {
      const newLastUser = findLastIndex(current, (m) => m.role === 'user');
      preserve.clear();
      if (systemIndex !== -1) {
        preserve.add(systemIndex);
      }
      if (newLastUser !== -1) {
        preserve.add(newLastUser);
      }
    }
  }

  return { messages: current, truncated };
}

// ---------------------------------------------------------------------------
// `aggressive` step 2 — merge similar adjacent messages.
// ---------------------------------------------------------------------------

interface MergeResult {
  messages: OpenAICompatibleMessage[];
  merged: number;
}

function applyMerge(messages: readonly OpenAICompatibleMessage[]): MergeResult {
  if (messages.length < 2) {
    return { messages: [...messages], merged: 0 };
  }

  let merged = 0;
  const result: OpenAICompatibleMessage[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1]!;
    const curr = messages[i]!;

    // NEVER merge tool-call-bearing messages (tool_calls or
    // tool_call_id present) — ADR § Tool-call integrity.
    const prevIsToolBearing =
      (prev.tool_calls !== undefined && prev.tool_calls.length > 0) ||
      prev.tool_call_id !== undefined;
    const currIsToolBearing =
      (curr.tool_calls !== undefined && curr.tool_calls.length > 0) ||
      curr.tool_call_id !== undefined;
    if (prevIsToolBearing || currIsToolBearing) {
      result.push(curr);
      continue;
    }

    // Only merge same-role adjacent messages.
    if (prev.role !== curr.role) {
      result.push(curr);
      continue;
    }

    // Only merge when both contents are strings (or null). Part-array
    // content carries vision/structured parts — merging them risks
    // dropping image parts or corrupting structure (ADR § Non-goals:
    // vision content never filtered). String-string merge is the safe
    // path the ADR's "content concatenated with `\n`" describes.
    if (!isStringOrNull(prev.content) || !isStringOrNull(curr.content)) {
      result.push(curr);
      continue;
    }

    const prevText = (prev.content as string | null) ?? '';
    const currText = (curr.content as string | null) ?? '';
    const sim = jaccardSimilarity(
      wordMultiset(prevText),
      wordMultiset(currText),
    );
    if (sim < MERGE_JACCARD_THRESHOLD) {
      result.push(curr);
      continue;
    }

    // Merge: content concatenated with a single `\n`.
    const mergedContent =
      prevText === '' && currText === ''
        ? ''
        : prevText === ''
          ? currText
          : currText === ''
            ? prevText
            : `${prevText}\n${currText}`;
    result[result.length - 1] = {
      role: prev.role,
      content: mergedContent,
    };
    merged++;
  }

  return { messages: result, merged };
}

// ---------------------------------------------------------------------------
// `aggressive` step 3 — strip non-essential metadata.
// ---------------------------------------------------------------------------

interface StripResult {
  messages: OpenAICompatibleMessage[];
  strippedFields: number;
}

function applyMetadataStrip(
  messages: readonly OpenAICompatibleMessage[],
): StripResult {
  let strippedFields = 0;
  const result = messages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    let messageStripped = 0;

    for (const key of Object.keys(record)) {
      if (!RECOGNISED_MESSAGE_KEYS.has(key)) {
        // Unknown top-level key — strip.
        messageStripped++;
        continue;
      }
      if (key === 'name') {
        // `name` is recognised but non-essential — always strip.
        messageStripped++;
        continue;
      }
      if (key === 'refusal') {
        // `refusal` is stripped only when empty string.
        if (record[key] === '') {
          messageStripped++;
        } else {
          kept[key] = record[key];
        }
        continue;
      }
      kept[key] = record[key];
    }

    strippedFields += messageStripped;
    return kept as unknown as OpenAICompatibleMessage;
  });

  return { messages: result, strippedFields };
}

// ---------------------------------------------------------------------------
// Tool-call integrity — binding rule (ADR § Tool-call integrity).
// ---------------------------------------------------------------------------

/**
 * Ensures every `tool_call` has a matching `tool_call_output` and vice
 * versa. Removes orphaned `tool`-role messages (whose `tool_call_id`
 * has no issuing assistant `tool_call`) and removes orphaned
 * `tool_call` entries from assistant messages (whose `id` has no
 * matching `tool`-role message). An assistant message left with no
 * `tool_calls` and no content after stripping orphaned calls is
 * dropped. Single pass is sufficient — the two sets are computed once
 * and the removals do not create new orphans (a dropped tool message
 * does not change the assistant set; a stripped tool_call does not
 * change the tool set).
 */
function enforceToolCallIntegrity(
  messages: readonly OpenAICompatibleMessage[],
): OpenAICompatibleMessage[] {
  // Set of call_ids present in some assistant message's tool_calls.
  const assistantCallIds = new Set<string>();
  // Set of tool_call_ids present in tool-role messages.
  const toolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.tool_calls !== undefined) {
      for (const call of message.tool_calls) {
        assistantCallIds.add(call.id);
      }
    }
    if (message.role === 'tool' && message.tool_call_id !== undefined) {
      toolCallIds.add(message.tool_call_id);
    }
  }

  // Paired = present in both sets. An id in only one set is orphaned.
  const result: OpenAICompatibleMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      // Drop tool messages whose call_id has no issuing assistant call.
      if (
        message.tool_call_id === undefined ||
        !assistantCallIds.has(message.tool_call_id)
      ) {
        continue;
      }
      result.push(message);
      continue;
    }

    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      // Strip tool_call entries whose id has no matching tool message.
      const keptCalls = message.tool_calls.filter(
        (call) => toolCallIds.has(call.id),
      );
      if (keptCalls.length === 0) {
        // No remaining tool_calls — drop the assistant if it has no
        // content, otherwise keep it as a content-only assistant turn.
        if (isEmptyContent(message.content)) {
          continue;
        }
        result.push({
          ...withRecognisedMetadata(message),
          role: message.role,
          content: message.content,
        });
        continue;
      }
      result.push({
        ...withRecognisedMetadata(message),
        role: message.role,
        content: message.content,
        tool_calls: keptCalls,
      });
      continue;
    }

    // Non-tool, non-tool-call message — keep as-is (re-emit to avoid
    // aliasing the input). Carry recognised metadata through so safe
    // does not silently drop `name`/`refusal` (ADR: those survive safe).
    result.push({
      ...withRecognisedMetadata(message),
      role: message.role,
      content: message.content,
    });
  }

  return result;
}

/**
 * Carries the recognised-but-non-essential metadata (`name`, `refusal`,
 * `reasoning_content`, `tool_call_id`) from the source message into a
 * rebuilt message. Used by `enforceToolCallIntegrity` so the integrity
 * rebuild does not silently drop keys that `safe` must preserve (ADR
 * 0007 § aggressive metadata strip is an `aggressive`-only step).
 * `role` and `content` are set by the caller; this helper only
 * contributes the optional recognised keys.
 */
function withRecognisedMetadata(
  message: OpenAICompatibleMessage,
): Partial<OpenAICompatibleMessage> {
  return {
    ...(message.tool_call_id !== undefined
      ? { tool_call_id: message.tool_call_id }
      : {}),
    ...(message.reasoning_content !== undefined
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(message.refusal !== undefined ? { refusal: message.refusal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Content helpers — pure, no side effects.
// ---------------------------------------------------------------------------

interface CleanedContent {
  content: OpenAICompatibleMessage['content'];
}

/**
 * Removes empty text parts (zero-length or whitespace-only) and trims
 * leading/trailing whitespace on each surviving text part. `image_url`
 * parts are kept untouched (vision content never filtered). Returns a
 * new content value; the input is not mutated.
 */
function cleanContent(message: OpenAICompatibleMessage): CleanedContent {
  const content = message.content;
  if (typeof content === 'string' || content === null || content === undefined) {
    // String content: trim leading/trailing whitespace. Internal
    // whitespace runs are NOT collapsed at `safe` (that is system-prompt
    // compaction, applied separately to `role:system` only).
    if (typeof content === 'string') {
      return { content: content.trim() };
    }
    return { content: content };
  }

  // Part array: filter empty text parts, trim surviving text parts.
  const cleanedParts: OpenAIContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      const trimmed = part.text.trim();
      if (trimmed.length === 0) {
        // Empty/whitespace-only text part — drop.
        continue;
      }
      cleanedParts.push({ type: 'text', text: trimmed });
    } else {
      // image_url — keep untouched (vision never filtered).
      cleanedParts.push(part);
    }
  }
  return { content: cleanedParts };
}

/**
 * Compacts system-prompt content: collapses runs of whitespace
 * (spaces, tabs, newlines) into a single space and trims. Applied to
 * string content and to `text` parts of part-array content. Returns
 * the compacted value and whether it changed.
 */
function compactSystemContent(
  content: OpenAICompatibleMessage['content'],
): { value: OpenAICompatibleMessage['content']; changed: boolean } {
  if (typeof content === 'string') {
    const compacted = content.replace(/\s+/g, ' ').trim();
    return { value: compacted, changed: compacted !== content };
  }
  if (content === null || content === undefined) {
    return { value: content, changed: false };
  }
  let changed = false;
  const compactedParts = content.map((part) => {
    if (part.type === 'text') {
      const compacted = part.text.replace(/\s+/g, ' ').trim();
      if (compacted !== part.text) {
        changed = true;
      }
      return { type: 'text' as const, text: compacted };
    }
    return part;
  });
  return { value: compactedParts, changed };
}

/**
 * Full structural equality of two messages — same role, identical
 * content (deep-equal, `image_url` parts by reference identity),
 * identical tool_calls (deep-equal), identical tool_call_id. Used by
 * `safe` dedup so only true duplicates are dropped.
 */
function messagesEqual(a: OpenAICompatibleMessage, b: OpenAICompatibleMessage): boolean {
  if (a.role !== b.role) {
    return false;
  }
  if (!contentDeepEqual(a.content, b.content)) {
    return false;
  }
  if (!toolCallsEqual(a.tool_calls, b.tool_calls)) {
    return false;
  }
  if (a.tool_call_id !== b.tool_call_id) {
    return false;
  }
  return true;
}

function contentDeepEqual(
  a: OpenAICompatibleMessage['content'],
  b: OpenAICompatibleMessage['content'],
): boolean {
  // Normalize null/undefined to null.
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (typeof na === 'string' && typeof nb === 'string') {
    return na === nb;
  }
  if (na === null && nb === null) {
    return true;
  }
  if (typeof na === 'string' || typeof nb === 'string') {
    return false;
  }
  if (na === null || nb === null) {
    return false;
  }
  // Both arrays.
  if (na.length !== nb.length) {
    return false;
  }
  for (let i = 0; i < na.length; i++) {
    const pa = na[i]!;
    const pb = nb[i]!;
    if (pa.type !== pb.type) {
      return false;
    }
    if (pa.type === 'text' && pb.type === 'text') {
      if (pa.text !== pb.text) {
        return false;
      }
    } else if (pa.type === 'image_url' && pb.type === 'image_url') {
      // Reference identity — two distinct image attachments are NOT
      // duplicates even when the bytes match (ADR § safe + Non-goals).
      if (pa !== pb) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function toolCallsEqual(
  a: OpenAICompatibleMessage['tool_calls'],
  b: OpenAICompatibleMessage['tool_calls'],
): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]!;
    const cb = b[i]!;
    if (ca.id !== cb.id) {
      return false;
    }
    if (ca.type !== cb.type) {
      return false;
    }
    if (ca.function.name !== cb.function.name) {
      return false;
    }
    if (ca.function.arguments !== cb.function.arguments) {
      return false;
    }
  }
  return true;
}

function isEmptyContent(content: OpenAICompatibleMessage['content']): boolean {
  if (content === null || content === undefined) {
    return true;
  }
  if (typeof content === 'string') {
    return content.length === 0;
  }
  return content.length === 0;
}

function isStringOrNull(content: OpenAICompatibleMessage['content']): boolean {
  return content === null || content === undefined || typeof content === 'string';
}

function wordMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (word.length === 0) {
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

function jaccardSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let intersection = 0;
  let union = 0;
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    const ca = a.get(key) ?? 0;
    const cb = b.get(key) ?? 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  if (union === 0) {
    return 0; // both multisets empty — not "identical", similarity 0
  }
  return intersection / union;
}

function findLastIndex<T>(
  array: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i]!)) {
      return i;
    }
  }
  return -1;
}