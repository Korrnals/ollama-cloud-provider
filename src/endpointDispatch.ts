/**
 * v0220 P2 (slice v0212-p2-turncontext-extraction) — the endpoint
 * dispatch seam. Pure refactor: the SEVEN near-identical dispatch
 * branches of `provideLanguageModelChatResponse` (responses-primary,
 * native-primary, responses-repeat, chat-primary,
 * responses-last-resort, chat-final, plus the unconditional final
 * chat stream) collapse into ONE ordered chain of guarded attempts
 * plus ONE result handler in the caller.
 *
 * Why a seam: every cross-cutting turn-scoped concern (vision hash
 * commit, model-404 accounting, explicit-mode errors) used to pay the
 * 7-site tax — a new concern had to touch all seven branches and
 * could silently miss one (D-3 had to thread `token` through all 7
 * commit sites). Now the caller handles a single discriminated
 * {@link AttemptOutcome} per attempt and commits/records in ONE
 * place.
 *
 * Semantics are byte-identical to the pre-extraction branches for
 * ALL request shapes, sequential AND concurrent (cascade QA audit
 * P2-2 + rework P2-1; the suite incl. the Issue #40 fallback-policy,
 * OCP-2 410, native 3×404, tunnel and interleaved-turn isolation
 * pins is the safety net). Concurrency note: this module holds NO
 * turn-scoped mutable state — everything it touches per request is
 * captured call-locally in {@link EndpointDispatchInputs} (and the
 * vision pending hashes live in the call-local TurnHandle, see
 * turnLedger.ts); the only cross-request state it mutates is the
 * module-level capability cache, exactly as the branches did:
 *   - the chain order is EXACT: responses-primary → native
 *     auto-recovery check → native-primary → responses-repeat →
 *     chat-primary → responses-last-resort → chat-final;
 *   - each attempt's guard reads the LIVE capability cache at its
 *     position (a 404 that marks an endpoint unavailable mid-chain
 *     disables a later same-endpoint step);
 *   - payload converters run LAZILY inside each attempt's invoke
 *     closure, exactly when the branch ran them — the converters log
 *     dropped system messages, so eager conversion would emit ghost
 *     log lines for branches that never fire;
 *   - POST is non-idempotent: no mid-stream fallback, no retry of a
 *     partially streamed request (ADR 0001/0005); 404/410 are the
 *     only fallback signals;
 *   - explicit endpoint choice (Issue #40) NEVER silently detours:
 *     a live 404 or a cached-unavailable short-circuit throws the
 *     actionable error instead.
 */

import * as vscode from 'vscode';
import { logger } from './logger.js';
import { OllamaClient } from './ollamaClient.js';
import { ResponsesClient } from './responsesClient.js';
import { HttpError } from './retry.js';
import {
  isChatKnownUnavailable,
  isNativeChatKnownUnavailable,
  isResponsesKnownUnavailable,
  mark404,
  markChatAvailable,
  markChatUnavailable,
  markNativeChatAvailable,
  markNativeChatUnavailable,
  markResponsesAvailable,
  markResponsesUnavailable,
  reset404s,
  shouldAutoSwitch,
  shouldRetryAfterSilence,
} from './capabilityCache.js';
import {
  convertMessagesToNative,
  convertOpenAIMessagesToNative,
  convertOpenAIToolsToNative,
  convertToolsToNative,
} from './convert.js';
import {
  convertOpenAIMessagesToResponsesInput,
  convertOpenAIToolsToResponses,
  convertToResponsesInput,
  convertToolsToResponses,
} from './convertResponses.js';
import { nativeBaseUrl } from './connections.js';
import type { ConnectionConfig } from './connections.js';
import type { StreamCallbacks, NativeChatMessage, NativeChatTool, OpenAICompatibleMessage, OpenAICompatibleTool } from './protocolTypes.js';
import type { ModelDefinition } from './modelCatalog.js';
import type {
  ModelConfigurationOptions,
  ResolvedModelRequestConfiguration,
} from './modelConfiguration.js';
import { resolveModelRequestConfiguration } from './modelConfiguration.js';
import type { ContextFilterReport } from './contextFilter.js';
import type { SsrfGuard } from './ssrfGuard.js';

/**
 * Issue #40 — builds the explicit-mode 404 error thrown when the user
 * explicitly chose `primaryEndpoint` and that endpoint returned 404.
 * The message names the failing endpoint, the connection, and the two
 * remediation paths (switch to `auto` for automatic fallback, or
 * switch to the other explicit endpoint). Surfaced as a
 * `LanguageModelError` so VS Code presents it consistently to the
 * chat participant that invoked the model.
 */
export function endpointExplicitUnavailableError(
  primaryEndpoint: 'responses' | 'chat' | 'native',
  connectionId: string,
): vscode.LanguageModelError {
  if (primaryEndpoint === 'responses') {
    return vscode.LanguageModelError.NotFound(
      `Endpoint /v1/responses returned 404 for connection "${connectionId}". You have explicitly chosen this endpoint. Set "ollamaCloud.preferredEndpoint" to "auto" for automatic fallback, or switch to "chat".`,
    );
  }
  if (primaryEndpoint === 'native') {
    return vscode.LanguageModelError.NotFound(
      `Endpoint /api/chat (native) returned 404 for connection "${connectionId}". You have explicitly chosen this endpoint. Set "ollamaCloud.preferredEndpoint" to "auto" for automatic fallback, or switch to "chat" or "responses".`,
    );
  }
  return vscode.LanguageModelError.NotFound(
    `Endpoint /chat/completions returned 404 for connection "${connectionId}". You have explicitly chosen this endpoint. Set "ollamaCloud.preferredEndpoint" to "auto" for automatic fallback, or switch to "responses".`,
  );
}

/**
 * Issue #40 — capability-cache short-circuit guard for explicit
 * mode. When the user explicitly chose `primaryEndpoint` AND the
 * capability cache already memoized that endpoint as unavailable
 * (a prior 404 in this session), the explicit-mode contract requires
 * the actionable error — NOT a silent detour to the other endpoint.
 * Without this guard, the cache would disable the primary attempt and
 * execution would fall through the chain to the other endpoint,
 * silently routing around the user's explicit choice. The cache
 * itself is NOT bypassed; the guard reads it and translates
 * "known unavailable + explicit" into the same error a live 404
 * would produce.
 */
export function guardExplicitEndpointCachedUnavailable(
  primaryEndpoint: 'responses' | 'chat' | 'native',
  connectionId: string,
  isPreferredEndpointExplicit: boolean,
): void {
  if (!isPreferredEndpointExplicit) {
    return;
  }
  if (primaryEndpoint === 'responses' && isResponsesKnownUnavailable(connectionId)) {
    logger.info(
      `Explicit /v1/responses cached-unavailable for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
    );
    throw endpointExplicitUnavailableError('responses', connectionId);
  }
  if (primaryEndpoint === 'chat' && isChatKnownUnavailable(connectionId)) {
    logger.info(
      `Explicit /chat/completions cached-unavailable for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
    );
    throw endpointExplicitUnavailableError('chat', connectionId);
  }
  // Phase 1 — native short-circuit guard (mirrors the chat one).
  if (primaryEndpoint === 'native' && isNativeChatKnownUnavailable(connectionId)) {
    logger.info(
      `Explicit /api/chat (native) cached-unavailable for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
    );
    throw endpointExplicitUnavailableError('native', connectionId);
  }
}

/**
 * The discriminated per-attempt result the caller handles ONCE:
 *   - `success` — the stream resolved (= `onDone` fired); the caller
 *     commits the turn's pending vision hashes and returns;
 *   - `fallback-404` — the attempt 404/410'd in auto mode and the
 *     policy already applied its cache marks + logs; the caller
 *     continues the chain at the next enabled attempt;
 *   - `terminal` — the caller must throw `error` (the provider's
 *     outer catch then records the failed vision sends and
 *     re-classifies it).
 */
export type AttemptOutcome =
  | { kind: 'success' }
  | { kind: 'fallback-404' }
  | { kind: 'terminal'; error: unknown };

/**
 * How an attempt handles an HTTP 404/410 from its own stream. The
 * three real policies are byte-identical relocations of the three
 * catch-handler shapes that existed across the seven branches:
 *   - `stable-primary` — responses/chat endpoints mark unavailable on
 *     the 1st 404 (stable endpoints — 1×404 means truly unsupported),
 *     count the per-model 404, throw in explicit mode, else log the
 *     auto-mode fallback and continue the chain;
 *   - `native-threshold` — only /api/chat uses the 3×404
 *     auto-recovery counter (experimental, may flap during rollout):
 *     below the threshold the ORIGINAL error is rethrown so the
 *     caller retries native on the NEXT request; at the threshold
 *     native is marked unavailable and the chain continues to chat;
 *   - `last-resort` — the responses fallback after a chat 404: the
 *     "both endpoints unavailable" line + always rethrow;
 *   - `none` — the unconditional final chat stream has no further
 *     fallback: every error (404 included) propagates as-is.
 */
export type Attempt404Policy =
  | { kind: 'stable-primary' }
  | { kind: 'native-threshold' }
  | { kind: 'last-resort' }
  | { kind: 'none' };

/** One stream attempt in the dispatch chain. */
export interface EndpointAttempt {
  /** Wire endpoint this attempt drives (selects the 404 policy's log lines + marks). */
  endpoint: 'responses' | 'native' | 'chat';
  /**
   * Guard evaluated at THIS attempt's position in the chain — reads
   * the live capability cache, so a 404 handled by an earlier
   * attempt can disable this one (and a `mark*Available` re-enable
   * it) exactly as the sequential `if` blocks did.
   */
  enabled: () => boolean;
  /**
   * Lazy stream kickoff. Constructs the client and converts the
   * payload ONLY when this attempt actually runs — the converters
   * log (dropped system messages etc.), so the conversion must not
   * happen for branches that never fire.
   */
  invoke: (callbacks: StreamCallbacks) => Promise<void>;
  /** Capability memoization on clean completion (runStream's onSuccess slot). */
  onSuccess: (() => void) | undefined;
  /** 404/410 handling for this attempt. */
  on404: Attempt404Policy;
}

/**
 * v0.9.0 Fix 3 — auto-recovery: if native was marked unavailable
 * (prior 404) but 5+ min have passed since the last 404, clear the
 * memo so the native path gets retried. This lets connections
 * recover from transient native-endpoint outages without a manual
 * config change or VS Code restart. Only applies in auto mode
 * (explicit mode throws on 404 and does not silently switch).
 * Chain step between the responses-primary and native-primary
 * attempts (its original source position).
 */
export interface NativeRecoveryStep {
  kind: 'native-recovery';
  shouldRecover: () => boolean;
  recover: () => void;
}

export type DispatchStep =
  | NativeRecoveryStep
  | { kind: 'attempt'; attempt: EndpointAttempt };

/** The provider's `runStream` bridge (callback contract ↔ async/await). */
export type RunStreamFn = (
  invoke: (callbacks: StreamCallbacks) => Promise<void>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  model: ModelDefinition,
  requestChars: number,
  onSuccess: (() => void) | undefined,
) => Promise<void>;

/**
 * Everything the chain needs from the provider turn. The provider
 * resolves auth/connection/filter/compaction state BEFORE dispatch
 * and hands it over; the factory below owns all endpoint-shaped
 * decisions from there on.
 */
export interface EndpointDispatchInputs {
  /** Compat (/chat/completions) client — built by the provider pre-dispatch (maybeCompact's summarizer shares it). */
  compatClient: OllamaClient;
  /** Non-cloud connection (legacy: `undefined` for cloud models) — threads into `ResponsesClient`. */
  connection: ConnectionConfig | undefined;
  /** `connection ?? cloudConnection` — drives the native base URL + client. */
  endpointConnection: ConnectionConfig | undefined;
  clientBaseUrl: string;
  apiKey: string;
  ssrfGuard: SsrfGuard;
  primaryEndpoint: 'responses' | 'chat' | 'native';
  isPreferredEndpointExplicit: boolean;
  isLocal: boolean;
  connectionId: string;
  model: ModelDefinition;
  modelOptions: ModelConfigurationOptions;
  /** Compat-format request configuration (native re-resolves lazily inside its attempt). */
  requestConfiguration: ResolvedModelRequestConfiguration;
  token: vscode.CancellationToken;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  requestChars: number;
  runStream: RunStreamFn;
  /** ArchCom 0011c Fix 2 — per-request once-latch so a multi-endpoint 404 chain counts one model 404. */
  markModel404Once: () => void;
  /** VS Code originals (`off` fast path below the compaction threshold). */
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  /** Filtered/compacted OpenAI-format payload (the SHAPED source). */
  filteredMessages: readonly OpenAICompatibleMessage[];
  /** v0220-a (P1) — filter ran OR compaction shaped the history. */
  shapedMessages: boolean;
  filteredTools: readonly OpenAICompatibleTool[] | undefined;
  filterReport: ContextFilterReport | undefined;
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
  toolMode: vscode.LanguageModelChatToolMode;
}

/**
 * ADR 0007 — resolves the `/v1/responses` `tools[]` array from the
 * filter state. When the context filter ran (`filterReport !==
 * undefined`, i.e. `safe`/`aggressive`), the filter produced a
 * filtered `OpenAICompatibleTool[]` (`filteredTools`) — convert it
 * directly to the `/v1/responses` tool schema via
 * `convertOpenAIToolsToResponses` (no VS Code ↔ OpenAI round-trip,
 * symmetric with `convertOpenAIMessagesToResponsesInput` for
 * messages). When the filter did NOT run (`off` fast path,
 * `filterReport === undefined`), convert the ORIGINAL VS Code
 * `options.tools` via `convertToolsToResponses` — the 375-test
 * regression path is untouched.
 *
 * `filteredTools` is the post-filter OpenAI-format tool list (the
 * filter dedupes by `function.name` and may drop entries). At `off`,
 * `filteredTools` holds the unfiltered `convertToolsToOpenAI` output —
 * but we still take the `options.tools` branch because the
 * `filterReport === undefined` signal means "use the original
 * conversion path", keeping the off-path byte-identical to pre-#39.
 */
function resolveResponsesTools(
  filterReport: ContextFilterReport | undefined,
  filteredTools: readonly OpenAICompatibleTool[] | undefined,
  originalTools: readonly vscode.LanguageModelChatTool[] | undefined,
): ReturnType<typeof convertOpenAIToolsToResponses> {
  if (filterReport !== undefined) {
    return convertOpenAIToolsToResponses(filteredTools);
  }
  return convertToolsToResponses(originalTools);
}

/**
 * ADR 0007 + v0220-a — resolves the native `/api/chat` `messages[]`
 * array from the upstream-transform state. When the context filter ran
 * (`safe`/`aggressive`) OR compaction shaped the history (fire or
 * sticky re-apply — `shapedMessages` true), convert the shaped
 * `OpenAICompatibleMessage[]` (`filteredMessages`) directly to the
 * native schema via `convertOpenAIMessagesToNative` (no VS Code ↔
 * OpenAI round-trip, symmetric with
 * `convertOpenAIMessagesToResponsesInput` for `/v1/responses`). When
 * NEITHER transform ran (`off` fast path below the compaction
 * threshold), convert the ORIGINAL VS Code `messages` via
 * `convertMessagesToNative` — the regression path is untouched.
 */
function resolveNativeMessages(
  shapedMessages: boolean,
  filteredMessages: readonly OpenAICompatibleMessage[],
  originalMessages: readonly vscode.LanguageModelChatRequestMessage[],
): NativeChatMessage[] {
  if (shapedMessages) {
    return convertOpenAIMessagesToNative(filteredMessages);
  }
  return convertMessagesToNative(originalMessages);
}

/**
 * ADR 0007 — resolves the native `/api/chat` `tools[]` array from the
 * filter state; the native mirror of `resolveResponsesTools`. When
 * the filter ran, convert the filtered `OpenAICompatibleTool[]`
 * directly via `convertOpenAIToolsToNative`; when the filter is `off`,
 * use the original `convertToolsToNative` conversion path.
 */
function resolveNativeTools(
  filterReport: ContextFilterReport | undefined,
  filteredTools: readonly OpenAICompatibleTool[] | undefined,
  originalTools: readonly vscode.LanguageModelChatTool[] | undefined,
): NativeChatTool[] | undefined {
  if (filterReport !== undefined) {
    return convertOpenAIToolsToNative(filteredTools);
  }
  return convertToolsToNative(originalTools);
}

function resolveToolChoice(
  toolMode: vscode.LanguageModelChatToolMode,
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): 'auto' | 'required' | 'none' | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return toolMode === vscode.LanguageModelChatToolMode.Required
    ? 'required'
    : 'auto';
}

/**
 * Runs ONE attempt through the provider's `runStream` and folds the
 * branch's catch-handler into the discriminated {@link AttemptOutcome}.
 * Non-404 errors are always terminal (surface, no fallback — no
 * double billing; ADR 0001/0005).
 */
export async function runStreamAttempt(
  attempt: EndpointAttempt,
  inputs: EndpointDispatchInputs,
): Promise<AttemptOutcome> {
  try {
    await inputs.runStream(
      attempt.invoke,
      inputs.progress,
      inputs.model,
      inputs.requestChars,
      attempt.onSuccess,
    );
    return { kind: 'success' };
  } catch (error) {
    if (
      attempt.on404.kind !== 'none' &&
      error instanceof HttpError &&
      (error.status === 404 || error.status === 410)
    ) {
      return handleAttempt404(attempt, error, inputs);
    }
    return { kind: 'terminal', error };
  }
}

/**
 * The relocated 404/410 catch-handler shapes. Every log line, cache
 * mark and throw is byte-identical to the corresponding pre-extraction
 * branch; see {@link Attempt404Policy} for the policy semantics.
 */
function handleAttempt404(
  attempt: EndpointAttempt,
  error: HttpError,
  inputs: EndpointDispatchInputs,
): AttemptOutcome {
  const { connectionId, isPreferredEndpointExplicit } = inputs;
  if (attempt.on404.kind === 'native-threshold') {
    // v0.9.0 Fix 3 (corrected) — track 404s for auto-recovery.
    // Do NOT mark unavailable on first 404 — that would switch
    // immediately, bypassing the 3×404 threshold. Instead:
    // increment counter, only mark unavailable when threshold hit.
    // Fix 2 — also track per-model 404s (retired-model hiding).
    inputs.markModel404Once();
    if (isPreferredEndpointExplicit) {
      logger.info(
        `Explicit /api/chat (native) 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
      );
      return {
        kind: 'terminal',
        error: endpointExplicitUnavailableError('native', connectionId),
      };
    }
    mark404(connectionId, 'native');
    if (shouldAutoSwitch(connectionId, 'native')) {
      logger.info(
        `Auto-recovery: connection "${connectionId}" hit 3×404 on native — switching to chat`,
      );
      markNativeChatUnavailable(connectionId);
    } else {
      logger.info(
        `Auto-mode: /api/chat returned ${error.status} for connection "${connectionId}" — will retry native on next request (see capability cache log for 404 count)`,
      );
      // Do NOT fall through to chat yet — retry native on next request.
      // Only after 3×404 do we switch (markNativeChatUnavailable above).
      // For THIS request, surface the 404 so the caller sees it.
      return { kind: 'terminal', error };
    }
    logger.info(
      `Auto-mode fallback: /api/chat returned ${error.status} for connection "${connectionId}" — retrying on /chat/completions`,
    );
    return { kind: 'fallback-404' };
  }
  if (attempt.on404.kind === 'last-resort') {
    // Asymmetry: responses/chat mark unavailable on the 1st 404 (stable endpoints — 1×404 means truly unsupported). Only native (/api/chat) uses the 3×404 auto-recovery counter (experimental, may flap during rollout). See capabilityCache.ts.
    markResponsesUnavailable(connectionId);
    // Fix 2 — track per-model 404s so a retired model is hidden
    // from the picker after 3 distinct-request 404s.
    inputs.markModel404Once();
    logger.info(
      `/v1/responses also returned ${error.status} for connection "${connectionId}" — both endpoints unavailable`,
    );
    return { kind: 'terminal', error };
  }
  // stable-primary (responses or chat).
  // Asymmetry: responses/chat mark unavailable on the 1st 404 (stable endpoints — 1×404 means truly unsupported). Only native (/api/chat) uses the 3×404 auto-recovery counter (experimental, may flap during rollout). See capabilityCache.ts.
  if (attempt.endpoint === 'responses') {
    markResponsesUnavailable(connectionId);
  } else {
    markChatUnavailable(connectionId);
  }
  // Fix 2 — track per-model 404s so a retired model is hidden
  // from the picker after 3 distinct-request 404s.
  inputs.markModel404Once();
  // Issue #40 — explicit choice: do NOT silently fall back.
  // Surface an actionable error so the user knows their
  // explicit endpoint is unsupported by this connection.
  if (isPreferredEndpointExplicit) {
    if (attempt.endpoint === 'responses') {
      logger.info(
        `Explicit /v1/responses 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
      );
      return {
        kind: 'terminal',
        error: endpointExplicitUnavailableError('responses', connectionId),
      };
    }
    logger.info(
      `Explicit /chat/completions 404 for connection "${connectionId}" — throwing (no fallback, user chose this endpoint explicitly)`,
    );
    return {
      kind: 'terminal',
      error: endpointExplicitUnavailableError('chat', connectionId),
    };
  }
  if (attempt.endpoint === 'responses') {
    logger.info(
      `Auto-mode fallback: /v1/responses returned ${error.status} for connection "${connectionId}" — retrying on /chat/completions`,
    );
  } else {
    logger.info(
      `Auto-mode fallback: /chat/completions returned ${error.status} for connection "${connectionId}" — retrying on /v1/responses`,
    );
  }
  return { kind: 'fallback-404' };
}

/**
 * Builds the ordered dispatch chain — the exact source order of the
 * seven pre-extraction branches:
 *
 *   1. responses-primary  (`primaryEndpoint==='responses'`)
 *   2. native auto-recovery check (no stream; clears a stale
 *      native-unavailable memo after 5+ min of silence)
 *   3. native-primary     (`primaryEndpoint==='native'`)
 *   4. responses-repeat   (same guard as (1), re-read AFTER the
 *      native step — unreachable while (1)'s 404 handler marks
 *      responses unavailable, kept for exact-order fidelity)
 *   5. chat-primary       (`!isLocal && primaryEndpoint==='chat'`)
 *   6. responses-last-resort (`!isLocal && primaryEndpoint==='chat'`
 *      && chat known-unavailable — the chat→responses fallback)
 *   7. chat-final         (unconditional: the responses→chat
 *      fallback and the only path for local Ollama)
 */
export function buildEndpointAttemptChain(
  inputs: EndpointDispatchInputs,
): DispatchStep[] {
  const {
    compatClient,
    connection,
    endpointConnection,
    clientBaseUrl,
    apiKey,
    ssrfGuard,
    primaryEndpoint,
    isPreferredEndpointExplicit,
    isLocal,
    connectionId,
    model,
    modelOptions,
    requestConfiguration,
    token,
    messages,
    filteredMessages,
    shapedMessages,
    filteredTools,
    filterReport,
    tools,
    toolMode,
  } = inputs;
  const apiModel = model.apiModel ?? model.id;
  const toolChoice = () => resolveToolChoice(toolMode, tools);

  // ADR 0007 + v0220-a — `/v1/responses` consumes the SHAPED payload.
  // When the filter ran (`filterReport !== undefined`) OR compaction
  // shaped the history (`shapedMessages`), shape the
  // `OpenAICompatibleMessage[]` directly into `/v1/responses` input
  // via `convertOpenAIMessagesToResponsesInput` (no VS Code ↔ OpenAI
  // round-trip — keeps the upstream transforms endpoint-agnostic and
  // avoids lossy re-conversion). When NEITHER ran (`off` fast path
  // below the compaction threshold), use the original
  // `convertToResponsesInput` on the VS Code `messages` (the pre-#39
  // regression path stays untouched).
  const responsesInvoke = (callbacks: StreamCallbacks): Promise<void> => {
    const responsesClient = new ResponsesClient(
      clientBaseUrl,
      apiKey,
      connection,
      ssrfGuard,
    );
    const { input, instructions } =
      shapedMessages
        ? convertOpenAIMessagesToResponsesInput(filteredMessages)
        : convertToResponsesInput(messages);
    const responsesTools = resolveResponsesTools(filterReport, filteredTools, tools);
    return responsesClient.streamResponses(
      {
        model: apiModel,
        input,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(responsesTools !== undefined ? { tools: responsesTools } : {}),
        tool_choice: toolChoice(),
        extraBody: requestConfiguration.openaiBody,
      },
      callbacks,
      token,
    );
  };

  // ADR 0007 + v0220-a — native `/api/chat` consumes the SHAPED
  // payload, mirroring the `/v1/responses` path above: when the
  // filter ran OR compaction shaped the history, convert the shaped
  // OpenAI messages/tools directly (no VS Code ↔ OpenAI round-trip);
  // when neither ran, the original conversion path runs unchanged.
  // Before ADR 0007, the native path silently bypassed the filter;
  // before v0220-a it silently bypassed compaction at filter `off`.
  // ADR 0013 lifecycle — already applied once above the dispatch
  // (all branches share it); no per-branch copy.
  // When `endpointConnection` is defined (the normal case — at least
  // one of `connection` / `cloudConnection` exists for any valid model
  // id), pass the native base URL explicitly via `nativeBaseUrl` so
  // the request lands on `/api/chat`. When `endpointConnection` is
  // undefined (a stale connection id pointing at a deleted
  // connection), fall back to the legacy `clientBaseUrl` and let
  // `OllamaClient.nativeChatUrl` strip `/v1` and append `/api/chat`
  // itself.
  const nativeInvoke = (callbacks: StreamCallbacks): Promise<void> => {
    const nativeClient = new OllamaClient(
      endpointConnection ? nativeBaseUrl(endpointConnection) : clientBaseUrl,
      apiKey,
      endpointConnection,
      'native',
      ssrfGuard,
    );
    const nativeMessages = resolveNativeMessages(shapedMessages, filteredMessages, messages);
    const nativeTools = resolveNativeTools(filterReport, filteredTools, tools);
    const nativeConfig = resolveModelRequestConfiguration(model, modelOptions, 'native');
    return nativeClient.streamChat(
      {
        model: apiModel,
        messages: nativeMessages,
        ...(nativeTools !== undefined ? { tools: nativeTools } : {}),
        tool_choice: toolChoice(),
        extraBody: nativeConfig.openaiBody,
      },
      callbacks,
      token,
    );
  };

  // ADR 0007 — `/chat/completions` consumes the FILTERED payload
  // (`filteredMessages` + `filteredTools`). At `off` these are the
  // unfiltered originals, so the 375-test regression path is
  // untouched.
  const chatInvoke = (callbacks: StreamCallbacks): Promise<void> =>
    compatClient.streamChat(
      {
        model: model.apiModel,
        messages: filteredMessages as OpenAICompatibleMessage[],
        tools: filteredTools as OpenAICompatibleTool[] | undefined,
        tool_choice: toolChoice(),
        extraBody: requestConfiguration.openaiBody,
      },
      callbacks,
      token,
    );

  return [
    // 1. Responses API path — restored from v0.7.3 (accidentally
    // removed in v0.8.0 endpoint routing rewrite). Uses compat schema
    // (thinking: {type}, not think: true).
    {
      kind: 'attempt',
      attempt: {
        endpoint: 'responses',
        enabled: () =>
          primaryEndpoint === 'responses' &&
          !isResponsesKnownUnavailable(connectionId),
        invoke: responsesInvoke,
        onSuccess: () => markResponsesAvailable(connectionId),
        on404: { kind: 'stable-primary' },
      },
    },
    // 2. v0.9.0 Fix 3 — native auto-recovery (see NativeRecoveryStep).
    {
      kind: 'native-recovery',
      shouldRecover: () =>
        primaryEndpoint === 'native' &&
        isNativeChatKnownUnavailable(connectionId) &&
        !isPreferredEndpointExplicit &&
        shouldRetryAfterSilence(connectionId),
      recover: () => {
        logger.info(
          `Auto-recovery: connection "${connectionId}" — native was unavailable, 5+ min elapsed since last 404 — retrying native`,
        );
        markNativeChatAvailable(connectionId);
      },
    },
    // 3. native `/api/chat` path — reached when
    // primaryEndpoint==='native', i.e. explicit 'native' OR 'auto'
    // (the default) resolving to native for cloud. Auto mode uses the
    // 3×404 auto-recovery; explicit mode throws on 404 (no silent
    // fallback).
    {
      kind: 'attempt',
      attempt: {
        endpoint: 'native',
        enabled: () =>
          primaryEndpoint === 'native' &&
          !isNativeChatKnownUnavailable(connectionId),
        invoke: nativeInvoke,
        onSuccess: () => {
          markNativeChatAvailable(connectionId);
          // v0.9.0 Fix 3 — reset the 404 counter on native success
          // so the auto-recovery window does not accumulate stale 404s.
          reset404s(connectionId, 'native');
        },
        on404: { kind: 'native-threshold' },
      },
    },
    // 4. responses-repeat — same guard as (1), re-read at this chain
    // position. A 404 handled by (1) marks responses unavailable, so
    // this step is skipped; it exists to mirror the original source
    // order exactly (defence against future policy changes between
    // the two positions).
    {
      kind: 'attempt',
      attempt: {
        endpoint: 'responses',
        enabled: () =>
          primaryEndpoint === 'responses' &&
          !isResponsesKnownUnavailable(connectionId),
        invoke: responsesInvoke,
        onSuccess: () => markResponsesAvailable(connectionId),
        on404: { kind: 'stable-primary' },
      },
    },
    // 5. /chat/completions primary — when the global/per-connection
    // setting is 'chat'.
    {
      kind: 'attempt',
      attempt: {
        endpoint: 'chat',
        enabled: () =>
          !isLocal &&
          primaryEndpoint === 'chat' &&
          !isChatKnownUnavailable(connectionId),
        invoke: chatInvoke,
        onSuccess: () => markChatAvailable(connectionId),
        on404: { kind: 'stable-primary' },
      },
    },
    // 6. /chat/completions 404'd earlier (or was cached-unavailable)
    // → try /v1/responses as the fallback. Same shaped-payload routing
    // as the primary /v1/responses path above.
    {
      kind: 'attempt',
      attempt: {
        endpoint: 'responses',
        enabled: () =>
          !isLocal &&
          primaryEndpoint === 'chat' &&
          isChatKnownUnavailable(connectionId),
        invoke: responsesInvoke,
        onSuccess: () => markResponsesAvailable(connectionId),
        on404: { kind: 'last-resort' },
      },
    },
    // 7. /chat/completions — the final fallback (from responses 404)
    // or the only path for local Ollama. No 404 handling: there is no
    // further fallback, every error propagates. The success callback
    // marks chat available for cloud only (local connections are not
    // tracked in the capability cache).
    {
      kind: 'attempt',
      attempt: {
        endpoint: 'chat',
        enabled: () => true,
        invoke: chatInvoke,
        onSuccess: isLocal ? undefined : () => markChatAvailable(connectionId),
        on404: { kind: 'none' },
      },
    },
  ];
}
