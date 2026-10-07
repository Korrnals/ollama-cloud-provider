import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { AuthManager } from './auth.js';
import { createCommitWindow } from './commitWindow.js';
import {
  countOpenAIRequestChars,
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  getMessageText,
  hasImageParts,
  isImageDataPart,
} from './convert.js';
import { validateConfiguration } from './configValidator.js';
import { runHealthCheckCommand } from './healthCheck.js';
import { logger, redactSensitive } from './logger.js';
import {
  getModelConfigurationSchema,
  resolveModelRequestConfiguration,
  type ModelConfigurationOptions,
  type ModelConfigurationSchema,
} from './modelConfiguration.js';
import {
  ModelCatalog,
  resolveVisionSupport,
  type ModelDefinition,
} from './modelCatalog.js';
import { OllamaClient } from './ollamaClient.js';
import {
  clearCapabilityCache,
  getCapabilityCacheSnapshot,
  markModel404,
} from './capabilityCache.js';
import {
  HttpError,
  MidStreamError,
  ZeroByteSocketCloseError,
  ConnectionInterruptedError,
  UpstreamIdleTimeoutError,
  PostBudgetExhaustedError,
  MaxDurationError,
  isSocketCloseError,
} from './retry.js';
import {
  SsrfBlockedError,
  SsrfDnsError,
  createProductionSsrfGuard,
  type SsrfGuard,
} from './ssrfGuard.js';
import {
  loadConnections,
  openAiBaseUrl,
} from './connections.js';
import type { ConnectionConfig } from './connections.js';
import { executePassThrough, shouldFallback, resolveVisionModel } from './visionFallback.js';
import { resolveVisionHistoryMode } from './visionHistory.js';
import { TurnLedger } from './turnLedger.js';
import {
  buildEndpointAttemptChain,
  guardExplicitEndpointCachedUnavailable,
  runStreamAttempt,
  type EndpointDispatchInputs,
} from './endpointDispatch.js';
import { executeTwoPhaseVision, warmImageDescriptionCache, sha256ShortHex } from './visionTwoPhase.js';
import type {
  OpenAICompatibleMessage,
  UsageInfo,
} from './protocolTypes.js';
import { filterContext, type ContextFilterLevel } from './contextFilter.js';
import { compactIfNeeded, fingerprintText, type CompactionState } from './compaction.js';
import { CompactionStore } from './compactionStore.js';
import { createSummarizer } from './compactionSummarizer.js';

const AUTH_REQUIRED_DETAIL =
  'Run Ollama Cloud: Set API Key to configure access.';
const PROVIDER_TOOLTIP = 'Ollama Cloud';

/**
 * Issue #41 — Strand 2. Resolves the effective endpoint label shown in
 * the model picker tooltip and logged on config change.
 *
 *   - local connection        → `/chat/completions (local)`
 *   - explicit `responses`    → `/v1/responses`
 *   - explicit `chat`         → `/chat/completions`
 *   - explicit `native`       → `/api/chat (native)`
 *   - `auto` (default)        → `auto (resolves to /api/chat (native))`
 *     when the global `preferredEndpoint` is the default `'auto'`,
 *     otherwise reflects the explicit global choice.
 *
 * Endpoint routing (ADR 0009) — `auto` (the default) resolves to
 * `native` (`/api/chat`) for cloud connections and `chat`
 * (`/chat/completions`) for local connections. Users can explicitly
 * choose `native` / `responses` / `chat` to override. The capability
 * cache + 404 fallback (native → chat) covers connections that don't
 * support `/api/chat`.
 *
 * The label is deliberately short and contains no host or auth material
 * so it is safe to surface in a tooltip and in the output log.
 */
function resolveEndpointLabel(connection: ConnectionConfig | undefined): string {
  if (!connection || connection.type === 'local') {
    return '/chat/completions (local)';
  }
  const preferred = connection.preferredEndpoint ?? 'auto';
  if (preferred === 'responses') {
    return '/v1/responses';
  }
  if (preferred === 'chat') {
    return '/chat/completions';
  }
  if (preferred === 'native') {
    return '/api/chat (native)';
  }
  // auto — resolves against the global setting. The package.json default
  // is 'auto', which resolves to native (/api/chat) for cloud. An explicit
  // global 'responses'/'chat'/'native' overrides that.
  const globalPreferred = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<'responses' | 'chat' | 'native' | 'auto'>('preferredEndpoint', 'auto');
  const resolvesTo =
    globalPreferred === 'auto' || globalPreferred === 'native'
      ? '/api/chat (native)'
      : globalPreferred === 'chat'
        ? '/chat/completions'
        : '/v1/responses';
  return `auto (resolves to ${resolvesTo})`;
}


/**
 * v0.12.0 Item 2 — generates a stable 8-hex-char ref id from an
 * error's message + stack. The ref is deterministic: the same error
 * (same message + same stack) yields the same ref, so a repeated
 * mid-stream failure produces a stable ref for trend analysis. The
 * ref is NOT a security-sensitive value — it is a truncated hash of
 * publicly-visible error text. Uses Node's `createHash` (already a
 * dependency via `compactionStore.ts`); no new deps.
 */
export function errorRefId(error: unknown): string {
  const msg = error instanceof Error ? `${error.message}|${error.stack ?? ''}` : String(error);
  const hash = createHash('sha256').update(msg, 'utf8').digest('hex');
  return hash.slice(0, 8);
}

/**
 * Phase 2 — classifies an error from `runStream` into a human-readable
 * `vscode.LanguageModelError` so VS Code shows the user a clear message,
 * not a raw stack trace. The raw error (with stack) is logged in
 * `runStream`'s `onError` handler before it reaches here.
 *
 * v0.12.0 Item 2 (ADR 0008, ADR 0011) — every classified error carries
 * a short ref id (`ref-<8hex>`) so the user can quote it in a bug
 * report and we can correlate it to the logged stack trace. The ref is
 * generated from the error's message+stack hash so the same error
 * yields a stable ref (a repeated mid-stream failure produces the same
 * ref, making trend analysis possible). The ref is appended to the
 * user-facing message in brackets and logged alongside the stack.
 */
export function classifyStreamError(error: unknown): Error {
  const ref = errorRefId(error);
  // v0.12.0 Item 2 — preserve `LanguageModelError` type when the error
  // is already a `LanguageModelError` (e.g. thrown by
  // `endpointExplicitUnavailableError`). The catch-all below would wrap
  // it in a plain `Error`, losing the `LanguageModelError` type that
  // tests and VS Code rely on. Instead, re-create with the same code +
  // message + ref id appended. This keeps `err instanceof
  // LanguageModelError` true downstream.
  if (error instanceof vscode.LanguageModelError) {
    const code = (error as vscode.LanguageModelError).code;
    const baseMsg = (error as Error).message;
    const refSuffix = baseMsg.includes(`[ref ${ref}]`) ? '' : ` [ref ${ref}]`;
    if (code === 'NotFound') {
      return vscode.LanguageModelError.NotFound(`${baseMsg}${refSuffix}`);
    }
    if (code === 'Blocked') {
      return vscode.LanguageModelError.Blocked(`${baseMsg}${refSuffix}`);
    }
    // Unknown code — fall through to catch-all (safer than guessing).
  }
  if (error instanceof MidStreamError) {
    // ADR 0008 Phase 1 — server-sent mid-stream error. Terminal (POST
    // is non-idempotent, no mid-stream retry per ADR 0005). Surface the
    // server's message verbatim + a ref id so the user can report it.
    // The raw stack is already logged by `runStream`'s onError handler.
    return new Error(`Ollama Cloud: ${error.serverMessage} [ref ${ref}]`);
  }
  // v0.12.0 ADR 0012 — SSRF guard blocked the URL. Surface a clean,
  // actionable message. The raw `SsrfBlockedError` already carries a
  // clean message (no stack), so pass it through. Classified as
  // Blocked — the request was rejected by the extension's own security
  // policy, not by the server.
  if (error instanceof SsrfBlockedError) {
    return vscode.LanguageModelError.Blocked(`${error.message} [ref ${ref}]`);
  }
  if (error instanceof SsrfDnsError) {
    // v0.20.1 (RCA: transient DNS ENOTFOUND on ollama.com surfaced as a
    // terminal raw error) — a human message naming the resolver failure
    // and the recovery path. The retry layer now retries these codes at
    // the connect phase; if the user still sees this message, the
    // retries were exhausted or the resolver is down for longer.
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: DNS не смог разрешить имя сервера ${error.hostname} (transient network issue) — проверь подключение/VPN; расширение повторит запрос автоматически при следующей попытке. [ref ${ref}]`,
    );
  }
  if (error instanceof ZeroByteSocketCloseError) {
    // ADR 0008 Phase 3 — server closed before any chunk. Retryable at
    // the connect boundary; if it escaped retry (retries exhausted or
    // maxRetries=0), surface a clean message naming the failure mode.
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: соединение закрыто сервером до получения данных. Попробуйте ещё раз — повторный запрос не тарифицируется (получено 0 токенов). [ref ${ref}]`,
    );
  }
  if (error instanceof PostBudgetExhaustedError) {
    // Review P2-1 (2026-09-14) — the shared POST budget ran out before
    // the request succeeded. Honest localized message naming the cap and
    // the last error class, instead of a raw English Error.
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: исчерпан лимит попыток запроса (6 POST на сообщение${error.lastErrorClass ? `, последняя ошибка: ${error.lastErrorClass}` : ''}). Сеть нестабильна — повторите запрос. [ref ${ref}]`,
    );
  }
  if (error instanceof UpstreamIdleTimeoutError) {
    // ArchCom 2026-09-14 (train A) — deterministic idle kill: the
    // cloud dropped the stream after a long silent thinking phase
    // (ollama/ollama#16108). Retrying an identical request reproduces
    // the same silence, so the extension does NOT auto-retry — the
    // honest message names the upstream issue and the quiet gap so
    // the owner understands this is not the extension's timers.
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: облако закрыло соединение после ${Math.round(error.quietMs / 1000)} с без данных — модель долго размышляла. Известная проблема Ollama Cloud (ollama/ollama#16108), на стороне расширения таймеры стрим не прерывали. Повторите запрос. [ref ${ref}]`,
    );
  }
  if (error instanceof MaxDurationError) {
    // D-2 review P3-1 — since the D-2 tagged teardown, a maxDuration
    // abort during read deterministically surfaces here as
    // MaxDurationError (readStreamOnce routes by the abortReason tag);
    // without this branch it fell into the generic catch-all and the
    // user lost the reason. Name the configured ceiling (in minutes)
    // and the setting that controls it.
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: достигнут лимит длительности запроса (${Math.round(error.timeoutMs / 60000)} мин) — поток прерван. Лимит настраивается параметром «ollamaCloud.requestMaxDurationMin»; при необходимости завершить длинный ответ повторите запрос. [ref ${ref}]`,
    );
  }
  if (error instanceof ConnectionInterruptedError) {
    // ADR 0008 Phase 2 level-4 — mid-stream socket close. ArchCom
    // 2026-09-14 §3.4: with the commit-window shipped, a CIE that
    // reaches the user is TERMINAL by construction — early breaks are
    // retried silently inside the window, so this fired after the
    // window closed (output was shown). The honest message says the
    // shown fragment may be incomplete and names the manual retry —
    // auto-retry here would duplicate already-visible text.
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: соединение прервано в середине ответа — показанный фрагмент может быть неполным. Автоповтор после начала показа отключён (повтор привёл бы к дублированию текста); повторите запрос. [ref ${ref}]`,
    );
  }
  if (error instanceof HttpError) {
    // Surface the server's actual error message when present (extracted
    // from the `{"error":"..."}` body by `extractErrorMessage`). Fall
    // back to a generic Russian message only when the server gave no
    // detail. Avoid duplicating the HTTP status prefix.
    const serverMsg =
      error.message && !error.message.startsWith('HTTP ')
        ? error.message
        : '';
    switch (error.status) {
      case 402:
        return vscode.LanguageModelError.Blocked(
          serverMsg
            ? `Ollama Cloud: ${serverMsg} [ref ${ref}]`
            : `Ollama Cloud: Payment Required (HTTP 402) — проверьте, что модель доступна на вашем тарифе, либо уменьшите контекст. [ref ${ref}]`,
        );
      case 403:
        return vscode.LanguageModelError.Blocked(
          serverMsg
            ? `Ollama Cloud: ${serverMsg} [ref ${ref}]`
            : `Ollama Cloud: Forbidden (HTTP 403) — авторизация отклонена сервером. [ref ${ref}]`,
        );
      case 429: {
        // ArchCom 0011c (PA finding — 429 Retry-After): surface the
        // server-provided Retry-After delay (parsed from the header by
        // httpErrorFromResponse into retryAfterMs) to the user so they
        // know how long to wait. Falls back to the generic message when
        // the server omitted the header (retryAfterMs undefined).
        const retryAfterSeconds =
          typeof error.retryAfterMs === 'number'
            ? Math.ceil(error.retryAfterMs / 1000)
            : undefined;
        return vscode.LanguageModelError.Blocked(
          serverMsg
            ? `Ollama Cloud: ${serverMsg} [ref ${ref}]`
            : retryAfterSeconds !== undefined
              ? `Ollama Cloud: Rate limit exceeded (HTTP 429) — повторите через ~${retryAfterSeconds} сек. [ref ${ref}]`
              : `Ollama Cloud: Rate limit exceeded (HTTP 429) — попробуйте позже. [ref ${ref}]`,
        );
      }
      case 404:
        return vscode.LanguageModelError.NotFound(
          serverMsg
            ? `Ollama Cloud: ${serverMsg} [ref ${ref}]`
            : `Ollama Cloud: Not Found (HTTP 404) — модель или эндпоинт недоступен. [ref ${ref}]`,
        );
      default:
        if (error.status >= 500) {
          // CR #7 — preserve LanguageModelError type for unknown 5xx
          // codes too (consistent with the 4xx branches above that
          // wrap as LanguageModelError.Blocked).
          return vscode.LanguageModelError.Blocked(
            serverMsg
              ? `Ollama Cloud: Server error (HTTP ${error.status}) — ${serverMsg} [ref ${ref}]`
              : `Ollama Cloud: Server error (HTTP ${error.status}) — проблема на стороне Ollama Cloud. [ref ${ref}]`,
          );
        }
        // CR #7 — unknown 4xx → Blocked, not plain Error (preserves
        // the LanguageModelError type VS Code surfaces consistently).
        return vscode.LanguageModelError.Blocked(
          `Ollama Cloud: HTTP ${error.status} — ${error.message} [ref ${ref}]`,
        );
    }
  }
  // ADR 0008 Phase 2 level-4 — unclassified socket/network error that
  // escaped the streaming clients' reclassification (e.g. a raw Node
  // socket close that bypassed the isSocketCloseError translation, or a
  // network error from a different code path). Wrap with a generic
  // "connection interrupted" message instead of surfacing the raw stack
  // trace to the user. The raw error is logged with its stack by the
  // caller (runStream onError handler) BEFORE reaching here.
  if (isSocketCloseError(error)) {
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: соединение прервано. Сервер или сеть закрыли соединение до завершения ответа. [ref ${ref}]`,
    );
  }
  // v0.12.0 Item 2 — unclassified error (the catch-all). Append a ref
  // id so even an unexpected failure is correlatable to the logged
  // stack trace. CR #7 — preserve the LanguageModelError type when the
  // source error already carries it (was already handled at the top
  // of this function, so this branch is only reached for non-LME
  // errors); wrap as Blocked so VS Code surfaces it consistently with
  // the rest of the classification.
  if (error instanceof Error) {
    return vscode.LanguageModelError.Blocked(
      `Ollama Cloud: ${error.message} [ref ${ref}]`,
    );
  }
  return vscode.LanguageModelError.Blocked(
    `Ollama Cloud: ${String(error)} [ref ${ref}]`,
  );
}


type ModelPickerInformation = vscode.LanguageModelChatInformation & {
  isUserSelectable?: boolean;
  statusIcon?: vscode.ThemeIcon;
  detail?: string;
  tooltip?: string;
  configurationSchema?: ModelConfigurationSchema;
  // PART B workaround — the Agents window model picker only surfaces
  // models whose LanguageModelChatInformation carries `isBYOK === true`.
  // This is a proposed-only field passed through at runtime via type
  // augmentation (no `enabledApiProposals` needed), mirroring
  // `isUserSelectable` / `statusIcon` above.
  isBYOK?: boolean;
};

export class OllamaCloudChatProvider
  implements vscode.LanguageModelChatProvider
{
  private readonly authManager: AuthManager;
  private readonly modelCatalog: ModelCatalog;
  private readonly onDidChangeLanguageModelChatInformationEmitter =
    new vscode.EventEmitter<void>();
  /**
   * ArchCom 0011c Fix 3 — per-model chars-per-token EMA. Different
   * models have different token densities (a CJK-heavy model vs an
   * English code model), so a single global EMA drifts when switching
   * models. Keyed by `apiModel`; defaults to 4 when no data yet.
   */
  private readonly charsPerTokenEMA = new Map<string, number>();
  private static readonly CHARS_PER_TOKEN_DEFAULT = 4;
  /**
   * v0.13.0 Slice 2 — per-conversation compaction hysteresis state
   * (per-model windows differ; spec: docs/compaction-spec.md § Slice 2).
   * Constructor-created.
   * v0.21.0 (slice d1) — the state is generic in the message type
   * because it now carries the remembered compaction projection
   * (stickiness); OpenAI-format messages here.
   * v0.22.0 (v0220-cc, D-1 review P2) — keyed by CONVERSATION, not
   * bare model id: two windows alternating the same model used to
   * clobber each other's state (each request re-keyed the same slot,
   * resetting the other window's projection + summary chain and
   * degenerating to the pre-d1 cadence with orphaned store blocks).
   * The key is `${modelId}::${conversationFingerprint}` — see
   * {@link conversationKey}. Accessed ONLY through the LRU accessors
   * {@link getCompactionState} / {@link setCompactionState} so stale
   * conversations are garbage-collected (cap
   * {@link COMPACTION_STATES_MAX}).
   */
  private readonly compactionStates = new Map<string, CompactionState<OpenAICompatibleMessage>>();
  /** v0220-cc P2 — LRU cap on remembered per-conversation states (bounded memory). */
  private static readonly COMPACTION_STATES_MAX = 8;
  /**
   * v0220-cc P3-b — per-message WIRE render memo (JSON.stringify).
   * One compaction check renders the same message objects 2-3×
   * (raw usage estimate, re-apply estimate over head+summary+tail,
   * evicted-block text, assembled-result estimate) — on multi-MB
   * vision histories that is 2-3 full-history stringify passes per
   * request. WeakMap keyed on the message OBJECT: entries die with
   * the message (VS Code re-sends fresh objects each turn, so the map
   * never grows stale); within one request the shared references hit
   * the memo. Accessed via {@link memoizedWireRender}.
   */
  private readonly wireRenderMemo = new WeakMap<object, string>();
  /**
   * v0220-cc P3-b — per-message BASIS render memo (canonical form),
   * same rationale as {@link wireRenderMemo}. Accessed via
   * {@link memoizedBasisRender}.
   */
  private readonly basisRenderMemo = new WeakMap<object, string>();
  /**
   * v0.12.1 — tracks model ids for which the context-inflation warning
   * has already fired this session. Prevents spamming the user on every
   * turn once the threshold is crossed and compaction is disabled.
   * v0.19.0 (ArchCom 2026-09-15 T2) — also carries the `${modelId}:unknown-window`
   * sentinel for the unknown-window no-fire path (one warn per model).
   */
  private readonly contextInflationWarned = new Set<string>();
  /**
   * v0220 P2 (slice v0212-p2-turncontext-extraction) — the ONE owner
   * of the vision turn bookkeeping: the instance-level sent/failed/
   * capped/warned maps + the per-turn pending hash container, and the
   * commit-on-success / failed-send / raw-resend-cap semantics that
   * used to live in six scattered fields + two methods here. The
   * provider opens a turn (`beginTurn`) at the top of every request,
   * applies the lifecycle (`applyLifecycle`), commits on stream
   * success (`commitTurn(token)`), and records failures in the catch
   * (`recordFailedTurn()`). Lifetime and semantics unchanged — see
   * turnLedger.ts.
   */
  private readonly turnLedger = new TurnLedger();
  /**
   * v0223 (task v0223-vision-cache-warm, D1) — hash → base64 bytes of
   * the images THIS provider instance RAW-sent on vision-primary
   * turns, captured at `applyLifecycle` time (first sends) and kept in
   * a bounded LRU-ish map per session. The background warmer (fired at
   * the commit points) needs the bytes to describe the image it
   * ALREADY served raw — by commit time the message array may have
   * been rewritten downstream, so the capture must happen at
   * lifecycle time, not at commit time. Bounded at 32 entries (a
   * screenshot's base64 ≈ 2 MB; a stale capture is only a warm-cache
   * optimization — dropping the oldest capture costs nothing: the
   * D2 marker path still covers a text-only re-send). A capture is
   * CONSUMED after its warm attempt (success or failure — the hash is
   * then either in the cache or covered by the D2 marker path; both
   * make the raw bytes worthless); captures for images that were
   * never committed (failed turn) die with the instance.
   */
  private readonly warmBase64ByHash = new Map<string, string>();
  /** Cap for {@link warmBase64ByHash} (insertion order = age). */
  private static readonly WARM_BASE64_MAX = 32;
  /**
   * v0.13.0 Slice 2 — root of the evicted-block store. Captured in the
   * constructor; the `CompactionStore` itself is created lazily because
   * test harnesses may build contexts without `globalStorageUri`.
   */
  private readonly compactionStorageUri: vscode.Uri | undefined;
  private compactionStore: CompactionStore | undefined;
  private lastCatalogSync = 0;
  private static readonly CATALOG_SYNC_COOLDOWN = 30_000;

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeLanguageModelChatInformationEmitter.event;

  /**
   * Exposed for the Issue 17 smart-notification wiring in `extension.ts`,
   * which needs to check whether an API key is set without going through
   * the command handler. Read-only access.
   */
  get auth(): AuthManager {
    return this.authManager;
  }

  constructor(context: vscode.ExtensionContext) {
    this.authManager = new AuthManager(context);
    this.modelCatalog = new ModelCatalog(this.authManager);
    this.compactionStorageUri = context.globalStorageUri;

    context.subscriptions.push(
      this.onDidChangeLanguageModelChatInformationEmitter,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('ollamaCloud.apiKey') ||
          event.affectsConfiguration('ollamaCloud.baseUrl') ||
          event.affectsConfiguration('ollamaCloud.connections') ||
          event.affectsConfiguration('ollamaCloud.visionModels') ||
          event.affectsConfiguration('ollamaCloud.allowedBaseUrls')
        ) {
          if (
            event.affectsConfiguration('ollamaCloud.baseUrl') ||
            event.affectsConfiguration('ollamaCloud.connections') ||
            event.affectsConfiguration('ollamaCloud.allowedBaseUrls')
          ) {
            // ArchCom 0011c (PA finding #2): clear capability cache
            // when connections change. Without this, a baseUrl change
            // (e.g. cloud → VPS) leaves stale 404 cache entries that
            // misroute requests until VS Code restart.
            clearCapabilityCache();
            void this.syncModelCatalog();
          }
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
        // Issue #40 — `preferredEndpoint` drives the explicit-vs-auto
        // endpoint decision. The capability cache memoizes per-endpoint
        // availability keyed by connection id; a stale entry from the
        // previous setting would short-circuit the new choice (and in
        // explicit mode now *throws* instead of silently routing). Clear
        // the cache so the next request re-probes both endpoints live.
        // Per-connection `preferredEndpoint` lives under
        // `ollamaCloud.connections` and is already covered by the
        // catalog-sync + emitter branch above; the global scalar key is
        // the only one that needs an explicit cache clear here.
        if (event.affectsConfiguration('ollamaCloud.preferredEndpoint')) {
          clearCapabilityCache();
          // Issue #41 — Strand 2: log the new effective endpoint per
          // connection so a config change is visible in the output log.
          // One line per connection — no host, no auth material.
          for (const conn of loadConnections()) {
            logger.info(
              `Endpoint changed: connection="${conn.id}" endpoint=${resolveEndpointLabel(conn)}`,
            );
          }
          // Issue #41 — must-fix: fire the information emitter so VS Code
          // re-queries `provideLanguageModelChatInformation` and the
          // model picker tooltip refreshes. Without this, changing only
          // the global `preferredEndpoint` setting leaves the
          // `Endpoint: auto (resolves to ...)` tooltip line stale until
          // some other event (catalog sync, apiKey change) fires the
          // emitter. Matches the pattern used by the
          // baseUrl/connections/apiKey branch above.
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
      context.secrets.onDidChange((event) => {
        // Fire on any ollamaCloud.apiKey* secret change so per-connection
        // key updates refresh the model picker status icons.
        if (event.key.startsWith('ollamaCloud.apiKey')) {
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
    );

    // Force VS Code to re-query model information after construction (e.g.
    // after extension update when cached data may lack current schemas).
    queueMicrotask(() =>
      this.onDidChangeLanguageModelChatInformationEmitter.fire(),
    );
  }

  async configureApiKey(): Promise<void> {
    const saved = await this.authManager.promptForApiKey();
    if (saved) {
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
    }
  }

  async clearApiKey(): Promise<void> {
    await this.authManager.deleteApiKey();
    this.onDidChangeLanguageModelChatInformationEmitter.fire();
    vscode.window.showInformationMessage('Ollama Cloud API key removed.');
  }

  async syncModelCatalog(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      now - this.lastCatalogSync < OllamaCloudChatProvider.CATALOG_SYNC_COOLDOWN
    ) {
      return;
    }
    this.lastCatalogSync = now;

    try {
      // Multi-connection refresh when `ollamaCloud.connections` is
      // populated; legacy single-connection refresh otherwise. The
      // legacy path preserves the 192 existing tests' behaviour.
      const connections = loadConnections();
      const result =
        connections.length > 1 ||
          (connections.length === 1 && connections[0]!.type !== 'cloud')
          ? await this.modelCatalog.refreshForConnections(connections)
          : await this.modelCatalog.refresh();
      logger.info(
        `Synced model list. changed=${result.changed} count=${result.count} connections=${connections.length}`,
      );
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
    } catch (error) {
      // ArchCom 0011c (PA finding #1): surface catalog sync failures
      // to the user — silent failure means stale model list with no
      // signal. The user picks a retired model and gets a confusing 404.
      logger.error('Failed to sync model list.', error);
      void vscode.window.showWarningMessage(
        'Ollama Cloud: failed to sync model list. The model picker may show outdated models. Check your connection and API key. See Output → Ollama Cloud for details.',
        'Open Logs',
      ).then((action) => {
        if (action === 'Open Logs') {
          logger.show();
        }
      });
    }
  }

  /**
   * Read-only access to the catalog list. Exposed for the vision
   * fallback command handlers (QuickPick of vision-capable models).
   */
  modelCatalogList(): readonly ModelDefinition[] {
    return this.modelCatalog.list();
  }

  async showRegisteredModels(): Promise<void> {
    const hasApiKey = await this.authManager.hasApiKey();
    const models = this.modelCatalog.list();

    logger.info(
      `Registered Ollama Cloud models. count=${models.length} hasApiKey=${hasApiKey}`,
    );
    for (const model of models) {
      logger.info(
        `model name="${model.name}" id="${model.id}" apiModel="${model.apiModel}" maxInputTokens=${model.maxInputTokens} maxOutputTokens=${model.maxOutputTokens} imageInput=${model.capabilities.imageInput} reasoning=${model.reasoning} capabilities=${model.capabilitySource ?? 'snapshot'}`,
      );
    }
    logger.show();

    void vscode.window.showInformationMessage(
      'Ollama Cloud model list written to the output log.',
    );
  }

  async checkConnection(): Promise<void> {
    // Issue 15 — delegate to the healthCheck module. It performs the
    // whitelist + API-key + reachability checks and shows the result
    // notification. This method is the command handler body.
    await runHealthCheckCommand(this.authManager);
  }

  /**
   * Command handler for `ollamaCloud.refreshModels` — force-syncs the
   * model catalog with a progress notification, bypassing the 30s
   * cooldown. After the sync completes, shows the model count so the
   * user sees the result of the refresh.
   */
  async refreshModelsCommand(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Ollama Cloud: Refreshing models...',
        cancellable: false,
      },
      () => this.syncModelCatalog(true),
    );
    const count = this.modelCatalog.list().length;
    vscode.window.showInformationMessage(
      `Ollama Cloud: ${count} models available.`,
    );
  }

  /**
   * v0.9.0 Fix 4 — command handler for `ollamaCloud.switchEndpoint`.
   * Shows a QuickPick with auto/native/chat/responses and updates the
   * global `ollamaCloud.preferredEndpoint` setting. Fires the
   * information emitter so the model picker tooltip refreshes
   * immediately (no reload needed). The onDidChangeConfiguration
   * listener clears the capability cache on the setting change.
   */
  async switchEndpoint(): Promise<void> {
    type EndpointPick = vscode.QuickPickItem & { value: 'auto' | 'native' | 'chat' | 'responses' };
    const current = vscode.workspace
      .getConfiguration('ollamaCloud')
      .get<'auto' | 'native' | 'chat' | 'responses'>('preferredEndpoint', 'auto');
    const items: EndpointPick[] = [
      {
        label: 'Auto',
        description: 'Automatically select endpoint with auto-recovery',
        detail: 'Switches to fallback on 3 consecutive 404s, returns to primary after 5 min',
        value: 'auto',
        picked: current === 'auto',
      },
      {
        label: 'Native (/api/chat)',
        description: 'Native Ollama endpoint',
        detail: 'ndjson wire format, object tool arguments, images[] for vision',
        value: 'native',
        picked: current === 'native',
      },
      {
        label: 'Chat (/chat/completions)',
        description: 'Classic OpenAI-compatible endpoint',
        detail: 'Falls back to /v1/responses on HTTP 404',
        value: 'chat',
        picked: current === 'chat',
      },
      {
        label: 'Responses (/v1/responses)',
        description: 'Structured reasoning, typed events, first-class tool calling',
        detail: 'Falls back to /chat/completions on HTTP 404',
        value: 'responses',
        picked: current === 'responses',
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Ollama Cloud: Switch Endpoint',
      placeHolder: `Current: ${current}`,
      canPickMany: false,
    });
    if (picked === undefined) {
      return; // user dismissed
    }
    await vscode.workspace
      .getConfiguration('ollamaCloud')
      .update('preferredEndpoint', picked.value, vscode.ConfigurationTarget.Global);
    logger.info(
      `Endpoint switched via command palette: ${picked.value} (was ${current})`,
    );
    // The onDidChangeConfiguration listener fires the emitter and clears
    // the cache, so no explicit fire is needed here. But fire once more
    // defensively in case the update was a no-op (same value) and the
    // tooltip detail still needs a refresh.
    this.onDidChangeLanguageModelChatInformationEmitter.fire();
  }

  async validateConfig(): Promise<void> {
    // Issue 16 — delegate to the configValidator module. It runs the
    // full validation suite (baseUrl whitelist, API key, reachability,
    // requestTimeoutMs, maxRetries) and shows the summary notification.
    await validateConfiguration(this.authManager);
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasApiKey = await this.authManager.hasApiKey();
    // Issue #41 — Strand 2: pass the model's connection so the tooltip
    // can show the effective endpoint. Resolved once per call. (Review
    // fix Finding 5: the previous `?? (cloud ? find cloud : undefined)`
    // fallback was fully redundant — the `find` already locates `cloud`
    // when `model.connectionId === 'cloud'`.)
    const connections = loadConnections();
    return this.modelCatalog
      .list()
      .map((model) => {
        const connection = connections.find((c) => c.id === model.connectionId);
        return toChatInformation(model, hasApiKey, connection);
      });
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    incomingMessages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // `messages` is mutable so the two-phase vision fallback can
    // shadow it with the rewritten history (image parts replaced by
    // the vision model's text description). Pass-through does not
    // reassign — it returns before the primary dispatch.
    let messages: vscode.LanguageModelChatRequestMessage[] = [...incomingMessages];
    const model = this.modelCatalog.get(modelInfo.id);
    if (!model) {
      throw new Error(`Unknown Ollama Cloud model: ${modelInfo.id}`);
    }

    // v0.20.1 (commit-on-success) — mint the turn's PENDING hash
    // handle on the ledger. The lifecycle records first-send hashes
    // THERE, not into the instance sent-set; only the attempt whose
    // stream genuinely resolved commits them (a 404 fallback that
    // retries a second endpoint within the SAME request shares the
    // handle). The handle is CALL-LOCAL (rework P2-1): concurrent
    // provideLanguageModelChatResponse calls each hold their own —
    // a parallel request can never wipe or commit this turn's pending
    // hashes. Opened ABOVE the try (v0.21.0 D-3) so the catch path can
    // route the leftover pending hashes into the failed-send counter.
    // See turnLedger.ts for the full contract.
    const turn = this.turnLedger.beginTurn();

    try {
      // Resolve the connection for this model. Cloud connection models
      // keep the legacy single-connection path (backward compatibility —
      // the 192 existing tests exercise this branch). Non-cloud
      // connection models resolve their connection via `connectionId`.
      const connections = loadConnections();
      // ADR 0006 — resolve the cloud connection object too (not just
      // non-cloud). Cloud models keep the legacy apiKey path
      // (`getApiKey()` + `connection = undefined` semantics for the
      // 192 existing tests), but the dispatch block below reads
      // `connection?.preferredEndpoint` to decide between
      // `/v1/responses` and `/chat/completions`. Without the cloud
      // connection object here, `preferredEndpoint: 'chat'` set on the
      // cloud connection is invisible to dispatch and every cloud
      // request routes to `/v1/responses` regardless of the override.
      // `apiKeyForCloud` keeps the legacy resolution; `connection` is
      // only used for endpoint selection + baseUrl (which already
      // fall back to `getBaseUrl()` when undefined).
      const cloudConnection =
        model.connectionId === 'cloud'
          ? connections.find((c) => c.id === model.connectionId)
          : undefined;
      const connection =
        model.connectionId === 'cloud'
          ? undefined
          : connections.find((c) => c.id === model.connectionId);

      // API key resolution — cloud connection uses the legacy
      // `getApiKey()` (SecretStorage + config + env fallback). Non-cloud
      // connections use `getApiKeyForConnection()` (SecretStorage only,
      // keyed `ollamaCloud.apiKey.<connectionId>`). Connections with
      // `requiresApiKey === false` (local Ollama) skip the key entirely.
      const apiKey = connection
        ? await this.authManager.getApiKeyForConnection(connection)
        : await this.authManager.getApiKey();
      if (!apiKey && (!connection || connection.requiresApiKey)) {
        throw new Error(
          'Ollama Cloud API key not configured. Run "Ollama Cloud: Set API Key".',
        );
      }

      // Vision gate — SEC-03 complement: do NOT silently drop image
      // attachments. Outcomes by branch (ArchCom 2026-09-15 variant
      // (b) — "unified vision descriptions"):
      //   - Text-only primary + fallback ENABLED (ADR 0004): route
      //     the turn to a vision model (two-phase describe or
      //     pass-through). Contract unchanged.
      //   - Text-only primary + fallback DISABLED: throw a clear
      //     error so the user sees why the request failed and can
      //     switch to a vision-capable model (constraint 9 — no
      //     silent degradation; unchanged).
      //   - Vision-capable primary + visionHistory.mode='marker'
      //     (default): the primary is NOT handed the raw image. The
      //     turn runs the unified two-phase describe (vision model
      //     describes, primary answers from the description). When
      //     the describe cannot run (no vision model resolvable) or
      //     fails, the history DEGRADES to the ADR 0013 marker cycle
      //     with a logger.warn — degradation, not silence, and never
      //     image bytes in the payload (owner directive: an image
      //     must not live in context in ANY outcome).
      //   - Vision-capable primary + visionHistory.mode='raw': the
      //     FIRST send of each image goes RAW to the primary (the
      //     v0.18 lifecycle); repeat re-sends from history still
      //     become markers (the lifecycle itself is mode-independent).
      // v0.12.1 — vision gate. `requestHasImages` is true only when
    // Copilot Chat actually passed image parts. For text-only models
    // Copilot Chat clips image attachments UNLESS the model advertised
    // `imageInput: true` in `toChatInformation`. When `visionFallback.enabled`
    // is on, `toChatInformation` advertises `imageInput: true` for
    // text-only models so the image reaches this gate, where the
    // existing ADR 0004 fallback routing takes over. When fallback is
    // off, the advertised capability stays `false` and no image arrives
    // (the pre-v0.12.1 behaviour).
    // Check ALL user messages for image parts — not just the last one.
    // Images in history still trigger the vision gate because
    // convertMessagesToOpenAI emits them into the request payload.
    const requestHasImages = messages.some(
      (m) => m.role === vscode.LanguageModelChatMessageRole.User && hasImageParts(m.content),
    );
    // ADR 0013 lifecycle — set true when a path above already
    // replaced image parts with descriptions/markers (the native
    // lifecycle then stays out of the way; see the native dispatch
    // block).
    let twoPhaseRewroteHistory = false;
      // ArchCom 2026-09-14 P0 fix — cloud models resolve `connection`
      // to undefined (legacy path), which silently dropped the user's
      // `ollamaCloud.visionModels` override for the cloud connection:
      // the gate fell back to `[]` patterns and a user-declared vision
      // model was still treated as text-only. `cloudConnection` carries
      // the same patterns (synthesizeCloudConnection injects the global
      // list), so coalescing restores the override for cloud too.
      const connectionVisionPatterns =
        (connection ?? cloudConnection)?.visionModels ?? [];
      const supportsImages = resolveVisionSupport(model, connectionVisionPatterns);
      if (requestHasImages && !supportsImages) {
        const fallbackEnabled = vscode.workspace
          .getConfiguration('ollamaCloud')
          .get<boolean>('visionFallback.enabled', false);
        if (fallbackEnabled && shouldFallback(model, messages)) {
          // ADR 0004 (superseded 2026-08-19) — vision fallback. Two
          // modes, selected by `ollamaCloud.visionFallback.mode`:
          //   - `two-phase` (default): vision model describes the
          //     image, then the primary model answers using the
          //     description. Falls through to the normal primary
          //     dispatch below with the rewritten history.
          //   - `pass-through`: vision model answers the user directly.
          //     Returns from here; the primary path is not reached.
          const fallbackMode = vscode.workspace
            .getConfiguration('ollamaCloud')
            .get<'two-phase' | 'pass-through'>('visionFallback.mode', 'two-phase');
          if (fallbackMode === 'pass-through') {
            // ADR 0013 lifecycle — pass-through streams the VISION
            // model's answer directly, but the request it sends still
            // carries the user history (images included). Apply the
            // re-send lifecycle here too: first RAW send reaches the
            // vision model; repeats become markers (same ~2M/turn
            // inflation fix as the primary dispatch — review P1-2).
            // v0.20.1 — hashes go into the PENDING container and are
            // committed only after the pass-through stream resolved.
            const passThroughMessages =
              resolveVisionHistoryMode() === 'marker'
                ? this.turnLedger.applyLifecycle(messages, turn)
                : messages;
            const passThroughResult = await executePassThrough({
              primaryModel: model,
              primaryConnection: connection ?? cloudConnection,
              messages: passThroughMessages,
              options,
              progress,
              token,
              authManager: this.authManager,
              catalog: this.modelCatalog.list(),
              connections,
            });
            const committedPassThrough = this.turnLedger.commitTurn(turn, token);
            // v0223 (D1) — same background warm-up as the primary
            // dispatch success path: the pass-through vision stream may
            // have seen committed RAW hashes this turn.
            this.warmVisionCacheAfterCommit(model, connection ?? cloudConnection, connections, token, committedPassThrough);
            return passThroughResult;
          }
          // two-phase — phase 1: vision describes the image, rewrite
          // history, then fall through to the primary dispatch below.
          // v0223 (D2) — the ledger-aware probe: hashes the TurnLedger
          // committed as sent RAW this session (a vision-primary first
          // send) never re-describe on a text-only primary — warm cache
          // or repeat marker (never a throw). See visionTwoPhase.ts.
          const twoPhaseResult = await executeTwoPhaseVision({
            primaryModel: model,
            primaryConnection: connection ?? cloudConnection,
            messages,
            options,
            progress,
            token,
            authManager: this.authManager,
            catalog: this.modelCatalog.list(),
            connections,
            sentHashProbe: (hash) => this.turnLedger.hasBeenSent(hash),
          });
          // Shadow the original messages with the rewritten history.
          // All downstream usages (`convertMessagesToOpenAI`,
          // `convertToResponsesInput`, `convertMessagesToNative`) now
          // see the text description instead of the image parts.
          messages = twoPhaseResult.messages;
          // Review P2-2 — surface partial degradation on the legacy
          // text-primary path (budget/failure): never silent.
          if (twoPhaseResult.degradedHashes.length > 0) {
            logger.warn(
              `vision two-phase: ${twoPhaseResult.degradedHashes.length} image(s) degraded to markers this turn (describe budget or failure) — hashes: ${twoPhaseResult.degradedHashes.join(', ')}`,
            );
          }
          // ADR 0013 lifecycle — the two-phase path already replaced
          // every image part with a description; the native lifecycle
          // must not record hashes from this rewritten history.
          twoPhaseRewroteHistory = true;
          // Fall through to the normal primary-model dispatch below.
        } else {
          throw new Error(
            `${model.name} does not support image input. Select a model with vision capability before attaching images.`,
          );
        }
      }
      // ArchCom 2026-09-15 variant (b) is SUPERSEDED for vision-capable
      // primaries by variant (v) — owner field report 2026-09-15: a
      // vision-capable primary (glm-5.3-flash) regressed to answering
      // through a second model's text DESCRIPTION, losing its direct
      // sight. The owner's directive is fulfilled differently by
      // primary type:
      //   - TEXT-ONLY primary: two-phase describe as before (the
      //     primary cannot see pixels at all; the description IS the
      //     only channel, and it is compacted like any text).
      //   - VISION-CAPABLE primary: sees the image RAW on the first
      //     send (v0.18 lifecycle below records the hash and replaces
      //     every history re-send with an in-band marker) — direct
      //     sight on the turn that matters, no pixels in context
      //     afterwards, markers compacted like text.
      // `visionHistory.mode='raw'` keeps the v0.18 semantics for both
      // primary types (first send raw, repeats markered).

      // ADR 0013 lifecycle extension (2026-09-15) — apply the
      // image-resend lifecycle ONCE, right after the vision gate,
      // for ALL dispatch branches (native / responses / compat) and
      // BOTH history modes. VS Code re-sends immutable history every
      // turn; without this the same screenshot re-uploads ~2M base64
      // chars PER TURN on every vision-capable path, inflating
      // sessions to 2.46M chars (the subagent D408 RCA). First send
      // of a hash: RAW; repeats: a short in-band marker. Skipped
      // when a two-phase pass above already rewrote the history (its
      // descriptions/markers replace the images) or when the request
      // carries no images. NOTE: since ArchCom 2026-09-15 the
      // lifecycle applies in `'raw'` mode TOO — `'raw'` opts out of
      // the unified describe (first send raw), NOT out of the
      // repeat-marker protection (that is the v0.18 lifecycle that
      // shipped with `'raw'` already in effect).
      if (requestHasImages && !twoPhaseRewroteHistory) {
        messages = this.turnLedger.applyLifecycle(messages, turn);
        // v0223 (D1) — capture the RAW first-send bytes for the
        // background cache warmer. The lifecycle left image parts in
        // `messages` exactly for the first sends of this turn; by
        // commit time the array may have been rewritten downstream, so
        // the base64 must be captured HERE. Bounded map (see the field
        // docblock); a hash whose warm-up succeeds is dropped by the
        // warmer, a never-committed capture dies with the instance.
        this.captureWarmBase64(messages);
      }

      const clientBaseUrl = connection
        ? openAiBaseUrl(connection)
        : this.authManager.getBaseUrl();

      // v0.12.0 ADR 0012 — SSRF guard. Defence-in-depth: the SEC-03
      // string-whitelist check already ran in the client (assertBaseUrl
      // AllowedOrThrow), but it cannot catch DNS-rebinding. The guard
      // resolves the hostname to an IP right before fetch and rejects
      // protected ranges (cloud metadata, RFC 1918, loopback, etc.).
      // Local connections allow loopback AND RFC 1918 private ranges
      // (v0.12.0 review P1 fix — LAN-hosted Ollama such as
      // http://192.168.1.50:11434 is a user-configured endpoint);
      // cloud metadata (169.254/16), CGNAT and all IPv6-sensitive
      // ranges stay blocked even for local. Cloud connections reject
      // everything private and point block errors at the whitelist.
      // Guard creation is cheap — one object allocation per request,
      // no DNS resolution at construction. Declared early so the
      // legacy `client` below (and all dispatch branches) can thread
      // it through.
      const isLocalConnection = connection?.type === 'local';
      const ssrfGuard: SsrfGuard = isLocalConnection
        ? createProductionSsrfGuard({ allowLoopback: true, allowPrivateRanges: true })
        : createProductionSsrfGuard({
            allowLoopback: false,
            advice: 'Check the URL or your ollamaCloud.allowedBaseUrls whitelist.',
          });

      const client = new OllamaClient(clientBaseUrl, apiKey ?? '', connection, 'compat', ssrfGuard);
      const modelOptions = options as ModelConfigurationOptions;
      const requestConfiguration = resolveModelRequestConfiguration(
        model,
        modelOptions,
      );
      let openaiMessages = convertMessagesToOpenAI(messages);
      // v0220-a (P1) — capture the PRE-compaction array reference.
      // `maybeCompact` returns this exact reference on every passthrough
      // path and a NEW array only when it shaped the history (a fire or
      // a sticky projection re-apply), so the identity check
      // `openaiMessages !== rawOpenAIMessages` after the call is the
      // precise "compaction shaped this turn" signal for endpoint
      // dispatch (see `shapedMessages` at the dispatch block).
      const rawOpenAIMessages = openaiMessages;

      // v0.13.0 Slice 2 — context compaction (spec:
      // docs/compaction-spec.md). Runs BEFORE the ADR 0007
      // context filter and BEFORE endpoint dispatch, so the filter
      // operates on the COMPACTED list. The injected summary message
      // (a `role:'system'` OpenAI message) reaches every endpoint,
      // but NOT uniformly: native + compat serve it as a system
      // message directly, while `/v1/responses` hoists only the FIRST
      // system message to `instructions` — the converters
      // (`convertToResponsesInput` /
      // `convertOpenAIMessagesToResponsesInput`) therefore FOLD the
      // `SUMMARY_MARKER` system message into `instructions` (extra
      // ordinary system messages stay dropped — P1-1, cascade review
      // 2026-10-02). Fallback contract: compaction never fails
      // the chat — every failure inside `maybeCompact` logs a warning
      // and returns the uncompacted history (the filter path may still
      // truncate; that is the accepted degradation).
      // v0.19.0 (ArchCom 2026-09-15 T2) — default flipped ON. The
      // `.get` default below stays `false` only as a defensive
      // fallback for hosts with a stale settings cache; the shipped
      // default lives in package.json (`true`).
      openaiMessages = await this.maybeCompact(
        openaiMessages,
        model,
        modelInfo.id,
        client,
        progress,
      );

      // ADR 0006 — endpoint selection deferred to the block below (it
      // needs `endpointConnection` + `globalConfig`). ADR 0007 context
      // filter is resolved in that same block so it can reuse
      // `endpointConnection` + `globalConfig` without recomputing them.
      // `requestChars` is computed AFTER the filter runs so it reflects
      // the FILTERED payload (used for the convert audit line + the
      // token estimator).
      let filteredMessages = openaiMessages;
      let filteredTools = convertToolsToOpenAI(options.tools);
      let filterReport: ReturnType<typeof filterContext>['report'] | undefined;
      let requestChars = 0;

      // ADR 0006 — endpoint selection. The user picks a primary endpoint
      // via `ollamaCloud.preferredEndpoint` (global setting, default
      // `'auto'`). Per-connection `preferredEndpoint` overrides
      // this: `'responses'`/`'chat'` are explicit; `'auto'` inherits the
      // global setting.
      //
      // Issue #40 — fallback policy. When the user EXPLICITLY chose the
      // primary endpoint (per-connection `'responses'`/`'chat'`, OR a
      // global `preferredEndpoint` the user actually configured rather
      // than the default), a 404 from that endpoint does NOT silently
      // fall back. The provider throws a clear, actionable error so the
      // user knows their explicit choice is unsupported by this
      // connection and can switch endpoints or opt into `auto`. When the
      // effective choice is `'auto'` (the default, or a per-connection
      // `'auto'` inheriting a default global), the prior fallback +
      // log-warning behaviour is preserved.
      //
      // The OTHER endpoint is the automatic fallback on HTTP 404:
      //   primary=responses → fallback=chat (and vice versa).
      // Local Ollama always uses /chat/completions (no /v1/responses).
      //
      // The capability cache short-circuits the primary attempt once a
      // prior 404 has been memoized for the connection. No mid-stream
      // fallback — POST is non-idempotent and a retry would bill twice
      // (ADR 0001/0005). The cache is intentionally NOT bypassed for
      // explicit mode: if an explicit endpoint is already known
      // unavailable (memoized from a prior 404 in this session), the
      // explicit-mode error must still fire — but it fires from the
      // cache short-circuit path, not from a fresh 404 round-trip. See
      // `endpointExplicitUnavailableError` below.
      const endpointConnection = connection ?? cloudConnection;
      const connectionPreferred = endpointConnection?.preferredEndpoint ?? 'auto';
      const isLocal = endpointConnection?.type === 'local';
      const connectionId = endpointConnection?.id ?? 'cloud';

      // ArchCom 0011c Fix 2 — retired-model tracking. Guard so a single
      // user request that 404s on multiple endpoints (e.g. responses →
      // chat fallback) only increments the per-model counter once. The
      // counter retires a model after 3 404s on DISTINCT requests.
      let model404AlreadyMarked = false;
      const markModel404Once = (): void => {
        if (!model404AlreadyMarked) {
          markModel404(connectionId, model.apiModel ?? model.id);
          model404AlreadyMarked = true;
        }
      };

      // Resolve the effective primary endpoint AND whether the choice is
      // explicit. Explicit = per-connection `'responses'`/`'chat'` (always
      // an override) OR a global `preferredEndpoint` the user actually
      // configured (detected via `inspect()` — `globalValue`/`workspaceValue`
      // set, vs. only `defaultValue`). `'auto'` per-connection inherits
      // the global explicitness.
      const globalConfig = vscode.workspace.getConfiguration('ollamaCloud');
      const globalInspection = globalConfig.inspect<'responses' | 'chat' | 'native' | 'auto'>('preferredEndpoint');
      const globalPreferredExplicit =
        globalInspection?.globalValue !== undefined ||
        globalInspection?.workspaceValue !== undefined ||
        globalInspection?.workspaceFolderValue !== undefined;
      // Phase 2 (2026-08-03 endpoint routing) — `auto` for cloud now
      // resolves to `native` (the documented canonical endpoint per
      // docs.ollama.com/cloud). `auto` for local stays `chat` (compat).
      // Users can still explicitly choose `responses`/`chat`/`native` to
      // override. The capability cache + 404 fallback (native → chat)
      // covers connections that don't support `/api/chat`.
      //
      // The package.json default for `preferredEndpoint` is `'auto'`, so
      // when a user never configures the setting, `.get()` returns
      // `'auto'`. Resolve `'auto'` explicitly to `native` (cloud) / `chat`
      // (local) below — without this, `globalPreferred === 'auto'` would
      // flow into `primaryEndpoint`, and no dispatch block matches
      // `primaryEndpoint === 'auto'` (see the dispatch blocks below and
      // ADR 0009).
      const globalPreferred = globalConfig.get<'responses' | 'chat' | 'native' | 'auto'>
      (
        'preferredEndpoint',
        'auto',
      );
      const isPreferredEndpointExplicit =
        !isLocal &&
        (connectionPreferred === 'responses' ||
          connectionPreferred === 'chat' ||
          connectionPreferred === 'native' ||
          (connectionPreferred === 'auto' && globalPreferredExplicit));

      // Resolve 'auto' explicitly: cloud → native (/api/chat per ADR 0009),
      // local → chat (local Ollama has no /api/chat). Without this, a user
      // who never configured preferredEndpoint inherits package.json
      // default 'auto', and globalPreferred would be 'auto' — a value no
      // dispatch block matches.
      const resolvedGlobal =
        isLocal
          ? 'chat'
          : globalPreferred === 'auto'
            ? 'native'
            : globalPreferred;
      const primaryEndpoint: 'responses' | 'chat' | 'native' =
        isLocal
          ? 'chat'
          : connectionPreferred === 'auto'
            ? resolvedGlobal
            : connectionPreferred;

      // ADR 0007 — resolve the effective context-filter level and run
      // the filter (only at `safe`/`aggressive` — `off` is a fast path
      // that skips `filterContext` entirely, preserving zero overhead
      // when the filter is disabled). Per-connection `contextFilter.level`
      // overrides the global; `'auto'`/`undefined` inherit the global
      // (mirrors `preferredEndpoint`). The filter is pure + endpoint-
      // agnostic: it runs once on the OpenAI-format `openaiMessages` and
      // the filtered output feeds BOTH endpoints — `/chat/completions`
      // via `filteredMessages` directly, `/v1/responses` via
      // `convertOpenAIMessagesToResponsesInput` (shapes the filtered
      // OpenAI messages into `/v1/responses` input without a VS Code ↔
      // OpenAI round-trip). `requestChars` is computed AFTER the filter
      // so it reflects the filtered payload (drives the convert audit
      // line + the token estimator).
      const connectionContextFilter = endpointConnection?.contextFilter ?? 'auto';
      const globalContextFilter = globalConfig.get<'off' | 'safe' | 'aggressive'>(
        'contextFilter.level',
        'off',
      );
      const effectiveFilterLevel: ContextFilterLevel =
        connectionContextFilter === 'auto'
          ? globalContextFilter
          : connectionContextFilter;
      if (effectiveFilterLevel !== 'off') {
        const filterResult = filterContext({
          messages: openaiMessages,
          tools: filteredTools,
          level: effectiveFilterLevel,
          maxInputTokens: model.maxInputTokens,
        });
        filteredMessages = filterResult.messages;
        filteredTools = filterResult.tools;
        filterReport = filterResult.report;
      }
      requestChars = countOpenAIRequestChars(filteredMessages);

      // Issue #41 — Strand 3.1: convert-path redundancy audit. Verdict
      // (verified 2026-07-29): NO redundancy in either converter.
      //   - `convertMessagesToOpenAI`: system prompt lives in exactly
      //     one `role:system` message; tool definitions go only in the
      //     top-level `tools` array (via `convertToolsToOpenAI`), never
      //     inlined into a message; instructions are not a `/chat/
      //     completions` concept so there is no `instructions`+message
      //     duplication vector.
      //   - `convertToResponsesInput`: the FIRST system message is
      //     hoisted to top-level `instructions`; subsequent system
      //     messages are dropped (logged), EXCEPT the compaction
      //     checkpoint (`SUMMARY_MARKER`), which is folded into
      //     `instructions` (P1-1). Tool definitions go only in
      //     the top-level `tools` array (via `convertToolsToResponses`).
      // No content is sent twice. The audit verdict is recorded in this
      // comment (review fix Finding 6: the per-request `convert audit:`
      // log line was removed — the verdict is static and `requestChars`
      // is already carried by the `Endpoint selected` line below, so the
      // per-request line was pure noise on the output channel).

      // ADR 0007 — context-filter log line. Emitted at `safe` /
      // `aggressive` only (NOT `off` — no logging at `off` per ADR).
      // The log carries char counts + drop counts ONLY — no message
      // content (sensitive-data policy: the filter log is a telemetry
      // line, not a content dump). Per-class diagnostics follow only
      // when the count for that class is non-zero (no "dropped 0"
      // noise), mirroring the Issue #41 convert-path diagnostic style.
      if (filterReport !== undefined) {
        const before = filterReport.beforeChars;
        const after = filterReport.afterChars;
        const saved =
          before === 0 ? 0 : Math.round(((before - after) / before) * 100);
        logger.info(
          `Context filter: level=${filterReport.level} before=${before}chars after=${after}chars saved=${saved}% (${filterReport.droppedMessages} messages dropped, ${filterReport.droppedTools} tools dropped, ${filterReport.mergedMessages} merged, ${filterReport.truncatedMessages} truncated)`,
        );
        if (filterReport.droppedMessages > 0) {
          logger.info(
            `Context filter: dropped ${filterReport.droppedMessages} duplicate messages`,
          );
        }
        if (filterReport.mergedMessages > 0) {
          logger.info(
            `Context filter: merged ${filterReport.mergedMessages} similar pairs`,
          );
        }
        if (filterReport.truncatedMessages > 0) {
          logger.info(
            `Context filter: truncated ${filterReport.truncatedMessages} oldest messages`,
          );
        }
        // v0.22.0 — a dropped checkpoint means compacted memory left the
        // context (oldest-first fallback under an impossible budget);
        // that is a quality-relevant loss, not routine hygiene — surface
        // it at WARN so field logs show it without digging.
        if (filterReport.truncatedCheckpoints > 0) {
          logger.warn(
            `Context filter: truncated ${filterReport.truncatedCheckpoints} compaction checkpoint(s) — compacted memory degraded this turn`,
          );
        }
        if (filterReport.droppedTools > 0) {
          logger.info(
            `Context filter: dropped ${filterReport.droppedTools} duplicate tools`,
          );
        }
        if (filterReport.strippedMetadataFields > 0) {
          logger.info(
            `Context filter: stripped metadata from ${filterReport.strippedMetadataFields} fields`,
          );
        }
      }

      logger.info(
        `Endpoint selected: primary=${primaryEndpoint}, explicit=${isPreferredEndpointExplicit}, connection="${connectionId}", isLocal=${isLocal}, apiModel="${model.apiModel ?? model.id}", requestChars=${requestChars}`,
      );

      // Issue #40 — capability-cache short-circuit guard for explicit
      // mode (moved to endpointDispatch.ts): "explicit choice +
      // endpoint memoized unavailable" must throw the actionable
      // error, NOT silently detour through the chain below.
      guardExplicitEndpointCachedUnavailable(
        primaryEndpoint,
        connectionId,
        isPreferredEndpointExplicit,
      );

      // v0220-a (P1) — dispatch gate for the message SOURCE. The
      // shaped `filteredMessages` array reaches the wire when EITHER
      // upstream transform ran:
      //   - the ADR 0007 context filter (`safe`/`aggressive` —
      //     `filterReport` set), or
      //   - compaction (fire or sticky projection re-apply), which runs
      //     at ANY filter level including `off` — detected by array
      //     identity (`maybeCompact` passes the original reference
      //     through otherwise).
      // Before this, the gate was `filterReport !== undefined` alone, so
      // at the shipped defaults (filter `off`, compaction ON since
      // v0.19.0) the two converter-based endpoints (native `/api/chat`,
      // `/v1/responses`) converted the RAW VS Code messages — the
      // compaction state machine ran (summarizer charged, store writes,
      // sticky projections) but its output never shaped the wire on
      // those endpoints. Filter level semantics are UNTOUCHED: `off`
      // still means no truncation, no `filterContext` call, no
      // `Context filter:` log — it does not mean "no compaction". When
      // NEITHER transform ran, every endpoint keeps its original VS
      // Code conversion path byte-for-byte (default-config users below
      // the compaction threshold see zero wire change; pinned by test).
      const shapedMessages =
        filterReport !== undefined || openaiMessages !== rawOpenAIMessages;

      // v0220 P2 (slice v0212-p2-turncontext-extraction) — the seven
      // dispatch branches collapsed into ONE ordered attempt chain +
      // ONE result handler (endpointDispatch.ts). The chain preserves
      // the exact source order: responses-primary → native
      // auto-recovery check → native-primary → responses-repeat →
      // chat-primary → responses-last-resort → chat-final (the
      // unconditional fallback / local-only path). Guards read the
      // LIVE capability cache at each position; payload converters
      // run lazily inside each attempt (they log — eager conversion
      // would emit ghost lines for branches that never fire). The
      // vision-hash commit is ONE place (success outcome) and the
      // failed-send recording ONE place (the catch below) — the D-3
      // "thread token through 7 commit sites" tax is gone.
      const dispatchInputs: EndpointDispatchInputs = {
        compatClient: client,
        connection,
        endpointConnection,
        clientBaseUrl,
        apiKey: apiKey ?? '',
        ssrfGuard,
        primaryEndpoint,
        isPreferredEndpointExplicit,
        isLocal,
        connectionId,
        model,
        modelOptions,
        requestConfiguration,
        token,
        progress,
        requestChars,
        runStream: this.runStream.bind(this),
        markModel404Once,
        messages,
        filteredMessages,
        shapedMessages,
        filteredTools,
        filterReport,
        tools: options.tools,
        toolMode: options.toolMode,
      };
      for (const step of buildEndpointAttemptChain(dispatchInputs)) {
        if (step.kind === 'native-recovery') {
          if (step.shouldRecover()) {
            step.recover();
          }
          continue;
        }
        if (!step.attempt.enabled()) {
          continue;
        }
        const outcome = await runStreamAttempt(step.attempt, dispatchInputs);
        if (outcome.kind === 'success') {
          // v0.20.1 — the stream resolved (= onDone fired): commit the
          // vision hashes this turn's lifecycle recorded as pending.
          const committed = this.turnLedger.commitTurn(turn, token);
          // v0223 (D1) — the committed hashes' images went RAW to a
          // model this turn; warm the persistent description cache for
          // them in the background (fire-and-forget — the primary turn
          // returns right after this). Silent, best-effort, never
          // blocks, never user-visible.
          this.warmVisionCacheAfterCommit(model, connection ?? cloudConnection, connections, token, committed);
          return; // success — no fallback needed
        }
        if (outcome.kind === 'terminal') {
          // The attempt's 404 policy decided there is no fallback
          // (explicit mode, native threshold not reached, last
          // resort, or a non-404 error — surface, no double billing).
          // The outer catch records the failed vision sends and
          // re-classifies.
          throw outcome.error;
        }
        // 'fallback-404' — the policy already applied its capability
        // marks + log lines; continue the chain at the next enabled
        // attempt. POST is non-idempotent: only a clean pre-stream
        // 404 may detour — never a mid-stream retry (ADR 0001/0005).
      }
    } catch (error) {
      // v0.21.0 D-3 — the turn ended WITHOUT its stream completing
      // (terminal error path): every hash this turn's lifecycle sent
      // RAW counts as a failed send toward the raw-resend cap. Empty
      // for turns that failed before any raw send (vision gate, etc.)
      // and already cleared when a commit point ran.
      this.turnLedger.recordFailedTurn(turn);
      logger.error('provideLanguageModelChatResponse failed.', error);
      throw classifyStreamError(error);
    }
  }

  /**
   * v0223 (D1) — records the base64 of every image part still present
   * in `messages` after the ADR 0013 lifecycle ran (the RAW first
   * sends of THIS turn) into {@link warmBase64ByHash}, bounded. Hashes
   * are the same SHA-256 shorts the warmer keys on. No logging of the
   * bytes (security — hashes only).
   */
  private captureWarmBase64(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): void {
    for (const message of messages) {
      if (!message || message.role !== vscode.LanguageModelChatMessageRole.User) {
        continue;
      }
      for (const part of message.content) {
        if (!isImageDataPart(part)) {
          continue;
        }
        const data = (part as vscode.LanguageModelDataPart).data;
        if (!data || data.length === 0) {
          continue;
        }
        const buffer = Buffer.from(data);
        const hash = sha256ShortHex(buffer);
        this.warmBase64ByHash.set(hash, buffer.toString('base64'));
      }
    }
    // Evict oldest captures when over the cap (insertion order = age).
    while (this.warmBase64ByHash.size > OllamaCloudChatProvider.WARM_BASE64_MAX) {
      const oldest = this.warmBase64ByHash.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.warmBase64ByHash.delete(oldest);
    }
  }

  /**
   * v0223 (task v0223-vision-cache-warm, D1) — the background
   * description-cache warmer, fired at BOTH stream-success commit
   * points (the endpoint-dispatch success outcome and the
   * pass-through early return) AFTER `turnLedger.commitTurn` returned
   * the hashes it actually committed.
   *
   * WHY: variant (v) removed the only writer of the persistent
   * `imageDescriptionCache` from the vision-primary channel — the raw
   * first send never describes, so nothing was cached; when the user
   * later switched to a TEXT-ONLY primary, the re-sent immutable
   * history hit the two-phase gate, the cache MISSED, and EVERY turn
   * fired a fresh describe call (with the "Describing image"
   * annotation, and a THROW on describe failure killing the turn —
   * owner field report 2026-10-06, minimax-m3 429s on glm-5.3 turns).
   * This warmer closes the loop: each hash committed THIS turn gets
   * ONE best-effort background describe through the same machinery as
   * the two-phase phase-1 (`warmImageDescriptionCache` — hardcoded
   * prompt, 90 s timeout, retry, throw-and-never-cache), so a later
   * text-only turn is a silent cache hit (or, when the warm-up failed,
   * the D2 ledger-aware marker — never a fresh describe, never a
   * throw).
   *
   * Fire-and-forget contract (D1):
   *   - schedules the warm-up and returns WITHOUT awaiting it — the
   *     primary turn's result flows to VS Code immediately (the
   *     describe's own await lives on the detached promise; its
   *     rejection is logged, never rethrown);
   *   - SILENT: no progress parts, no annotation, no user-visible
   *     surface; a failure logs (hash + reason) and writes NOTHING
   *     into the cache;
   *   - dedupe: hashes already in the cache are skipped inside
   *     `warmImageDescriptionCache` (one describe per new committed
   *     image per session);
   *   - skipped entirely when `visionHistory.mode === 'raw'` (the raw
   *     mode's explicit opt-out of the describe channel — checked at
   *     SCHEDULING per D1) or when no vision model resolves (log
   *     only — best-effort), or when the committed list is empty (a
   *     text-only turn with no images, the common case — zero cost).
   *
   * Cancellation: the primary turn's token aborts the in-flight
   * describe attempt (same pattern as the phase-1 loop). A turn
   * cancel that reached the commit site as a D-2 quiet completion
   * routed the hashes to the FAILED counter (never committed) —
   * `committed` is then empty and nothing warms.
   */
  private warmVisionCacheAfterCommit(
    primaryModel: ModelDefinition,
    primaryConnection: ConnectionConfig | undefined,
    connections: readonly ConnectionConfig[],
    token: vscode.CancellationToken,
    committedHashes: readonly string[],
  ): void {
    try {
      if (committedHashes.length === 0) {
        return;
      }
      // 'raw' mode opts out of the describe channel entirely — no
      // warm-up (checked at SCHEDULING, per D1).
      if (resolveVisionHistoryMode() !== 'marker') {
        return;
      }
      void this.launchWarmDescribe(
        primaryModel,
        primaryConnection,
        connections,
        token,
        committedHashes,
      ).catch((error: unknown) => {
        // Unhandled-rejection guard on top of launchWarmDescribe's own
        // catch — belt and braces (D1: log-only, never user-visible).
        logger.info(
          `vision cache warm: skipped (${error instanceof Error ? error.message : String(error)})`,
        );
      });
    } catch (error) {
      // Scheduling itself must never break the just-committed turn.
      logger.info(
        `vision cache warm: scheduling skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /**
   * v0223 (D1) — resolves the vision model with the SAME resolution
   * the two-phase path uses (`resolveVisionModel` — catalog +
   * connections + the primary's connection; `visionFallback.model`
   * wins, else auto-search) and runs `warmImageDescriptionCache` for
   * the given hashes. Every failure inside is logged (hash + reason)
   * and rethrown only to the `.catch` above — never across a turn
   * boundary, never into the cache (throw-and-never-cache inside
   * `describeImageOnce`).
   */
  private async launchWarmDescribe(
    primaryModel: ModelDefinition,
    primaryConnection: ConnectionConfig | undefined,
    connections: readonly ConnectionConfig[],
    token: vscode.CancellationToken,
    committedHashes: readonly string[],
  ): Promise<void> {
    const target = resolveVisionModel(
      primaryModel,
      primaryConnection,
      this.modelCatalog.list(),
      connections,
    );
    if (!target) {
      logger.info(
        'vision cache warm: no vision-capable model resolvable — skipping (best-effort)',
      );
      return;
    }
    const { model: visionModel, connection: visionConnection } = target;
    // Per-connection key isolation (same as the two-phase path).
    const apiKey = visionConnection
      ? await this.authManager.getApiKeyForConnection(visionConnection)
      : await this.authManager.getApiKey();
    if (!apiKey && (!visionConnection || visionConnection.requiresApiKey)) {
      logger.info(
        'vision cache warm: no API key for the vision connection — skipping (best-effort)',
      );
      return;
    }
    const baseUrl = visionConnection
      ? openAiBaseUrl(visionConnection)
      : this.authManager.getBaseUrl();
    const images = new Map<string, string>();
    for (const hash of committedHashes) {
      const base64 = this.warmBase64ByHash.get(hash);
      if (base64 !== undefined) {
        // warmImageDescriptionCache re-filters hashes already in the
        // persistent cache — the dedupe lives there, single source.
        images.set(hash, base64);
      }
    }
    // (Captures absent → nothing to describe with; the D2 marker path
    // still covers a later text-only re-send — no warm attempt.)
    if (images.size === 0) {
      return;
    }
    try {
      await warmImageDescriptionCache({
        visionModel,
        visionConnection,
        apiKey: apiKey ?? '',
        baseUrl,
        images,
        token,
      });
    } catch (error) {
      // D1 — the describe's throw (via `describeImageOnce`) surfaces
      // here as a log line: the warm-up failure NEVER poisons the
      // cache; the next text-only turn resolves the hash via the D2
      // ledger-aware marker path.
      logger.info(
        `vision cache warm: describe failed — hash(es)=${committedHashes.map((h) => h.slice(0, 8)).join(',')} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // The capture is consumed after exactly ONE warm attempt (success
      // or failure): the hash is then either in the cache or covered by
      // the D2 marker path — the raw bytes are worthless either way.
      for (const hash of images.keys()) {
        this.warmBase64ByHash.delete(hash);
      }
    }
  }

  async provideTokenCount(
    _modelInfo: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const rawText = getMessageText(text);
    // Fix 3 — resolve the model-specific charsPerToken. Falls back to the
    // default when the model is unknown or has no observed usage yet.
    const model = this.modelCatalog.get(_modelInfo.id);
    const apiModel = model?.apiModel ?? _modelInfo.id;
    const charsPerToken =
      this.charsPerTokenEMA.get(apiModel) ??
      OllamaCloudChatProvider.CHARS_PER_TOKEN_DEFAULT;
    return Math.max(1, Math.ceil(rawText.length / charsPerToken));
  }

  private updateTokenEstimate(
    requestChars: number,
    usage: UsageInfo,
    apiModel: string,
  ): void {
    if (!requestChars || !usage.inputTokens) {
      return;
    }

    // Bug 2 fix (2026-08-19 RCA) — skip the EMA update when the request
    // contains image data URLs. `countOpenAIRequestChars` counts the
    // full base64 payload of every image part (1M+ chars per image),
    // but the server counts image tokens correctly (~1K per image).
    // The ratio `requestChars / usage.inputTokens` becomes ~1000+
    // instead of ~4, poisoning the EMA: after a few vision requests
    // `charsPerToken` drops to ~0.47, making every token estimate
    // explode (e.g. `usedTokens=2.3M` for a 750K-window model).
    //
    // The EMA is only meaningful for text-only requests where
    // `requestChars` is a reasonable proxy for token count. Vision
    // requests are excluded entirely — the default (4 chars/token)
    // is a better estimate for vision than the poisoned EMA.
    //
    // Heuristic: if `requestChars / usage.inputTokens` exceeds 20
    // (i.e. >5x the default density), the request likely contained
    // images or other binary payloads — skip the update.
    const observed = requestChars / usage.inputTokens;
    if (observed > 20) {
      logger.debug(
        `updateTokenEstimate: skipping EMA update — observed=${observed.toFixed(1)} chars/token exceeds 20 (likely image data in request), keeping current EMA.`,
      );
      return;
    }
    // Fix 3 — EMA is tracked PER MODEL so switching models does not
    // contaminate one model's density estimate with another's.
    const prev =
      this.charsPerTokenEMA.get(apiModel) ??
      OllamaCloudChatProvider.CHARS_PER_TOKEN_DEFAULT;
    this.charsPerTokenEMA.set(apiModel, prev * 0.7 + observed * 0.3);
  }

  /**
   * v0.13.0 Slice 2 — returns the evicted-block store, creating it on
   * first use. Returns `null` when the host context carried no
   * `globalStorageUri` (mock contexts in tests) — compaction requires
   * the pointer store and degrades to passthrough without it.
   */
  private getOrCreateCompactionStore(): CompactionStore | null {
    if (!this.compactionStore) {
      if (!this.compactionStorageUri?.fsPath) return null;
      this.compactionStore = new CompactionStore(this.compactionStorageUri);
    }
    return this.compactionStore;
  }

  /**
   * v0.22.0 (v0220-cc, QA-audit P2) — recognizes the three in-band
   * image markers emitted by `visionHistory.ts` (`MARKER_TEMPLATE`,
   * `degradedImageMarker`, `neverSentImageMarker`): all open with
   * `[Image <16-hex hash> — `; the never-sent variant appends an
   * attempts note after the closing bracket. Captures the hash so
   * {@link renderCompactionBasis} can canonicalize a marker back to
   * the identity of the image it replaced.
   *
   * v0220-t (CC review P3-3) — the hash alternation also captures the
   * `no-image` sentinel: a zero-byte image hashes to `'no-image'`
   * (mirroring `visionHistory`), so its marker reads
   * `[Image no-image — …]`. Without the alternation the marker was not
   * stripped and the sentinel not pushed, so raw↔marker canonicalization
   * diverged for zero-byte images.
   */
  private static readonly IMAGE_MARKER_RE =
    /\[Image ([0-9a-f]{16}|no-image) — [^\]]*\](?: \[image never successfully sent — \d+ attempts failed\])?/g;

  /**
   * v0.22.0 (v0220-cc, QA-audit P2) — vision-state-INDEPENDENT render
   * of an OpenAI-format message, used ONLY as the projection-basis
   * fingerprint render (`compactIfNeeded`'s `basisRender`).
   *
   * Why: vision-state transitions (raw→marker on the v0.20.1 commit,
   * raw→never-sent-marker on the D-3 cap) rewrite a message INSIDE the
   * d1 prefix basis. A basis fingerprinted over the WIRE render
   * (`JSON.stringify`, raw base64 vs ~100-char marker) flips on the
   * very next turn → projection dropped → one-turn full-history
   * whiplash + cooldown-gated re-fire (self-healing but real).
   *
   * Canonical form per message — `user␂<text>␂<JSON array of sorted
   * hashes>`:
   *   - text: the concatenated text of the message with every image
   *     marker STRIPPED (markers are state, not content);
   *   - hashes: the sorted set of image identities — the 16-hex sha
   *     extracted from markers, or recomputed from a raw
   *     `data:…;base64,` URL (`sha256ShortHex` over the decoded bytes
   *     — byte-identical to the hash the vision lifecycle computed on
   *     the raw part, so the SAME image yields the SAME identity in
   *     raw and marker form). Sorted because the raw form separates
   *     text/image parts while the marker form concatenates them,
   *     losing the interleave order — ordering of image identities
   *     themselves is preserved by sorting deterministically. Encoded
   *     as a JSON array (QA P3-1, task v0221-p3) — a plain comma join
   *     let a comma inside one identity collide with the two-identity
   *     form.
   * Non-user messages never change render across vision states (the
   * lifecycle rewrites user messages only) — the wire render is
   * already stable for them. The WIRE render is untouched: estimates,
   * store payloads and summarizer prompts keep seeing raw/markers
   * exactly as before.
   */
  private renderCompactionBasis(m: OpenAICompatibleMessage): string {
    const hashFromDataUrl = (url: string): string => {
      // Mirror visionHistory's empty-data sentinel so a zero-byte
      // image canonicalizes identically in raw and marker form.
      const prefix = 'data:';
      const sep = ';base64,';
      const at = url.indexOf(sep);
      if (!url.startsWith(prefix) || at < 0) {
        // v0220-t (CC review P4-1) — non-data URLs are namespaced with
        // a `url:` prefix: opaque but stable (never rewritten), and a
        // client-set image_url.url of `'no-image'` or a 16-hex string
        // can no longer collide with a REAL identity (the zero-byte
        // sentinel or a sha hex) in the sorted hash set.
        return `url:${url}`;
      }
      const b64 = url.slice(at + sep.length);
      if (b64.length === 0) return 'no-image';
      return sha256ShortHex(Buffer.from(b64, 'base64'));
    };
    if (m.role !== 'user') return JSON.stringify(m);
    let text = '';
    const hashes: string[] = [];
    const stripMarkers = (s: string): string =>
      s.replace(OllamaCloudChatProvider.IMAGE_MARKER_RE, (_, hash: string) => {
        hashes.push(hash);
        return '';
      });
    const content = m.content;
    if (typeof content === 'string') {
      text = stripMarkers(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          text += stripMarkers(part.text);
        } else if (part.type === 'image_url') {
          hashes.push(hashFromDataUrl(part.image_url.url));
        }
      }
    }
    hashes.sort();
    // QA P3-1 (task v0221-p3) — JSON-array encode the sorted hash set.
    // The former `join(',')` was not injective: a non-data `url:` identity
    // whose URL contains a comma could equal the joined form of TWO
    // identities (`url:a,url:b` — one image with url `a,url:b`, or two
    // images `a` + `b`), colliding distinct messages onto one fingerprint.
    // JSON's per-element quoting keeps every comma inside its element.
    // Sorted → deterministic. The fingerprint format is internal and
    // in-memory (conversation keys live in the per-session
    // `compactionStates` LRU, reset on reload) — no persisted basis to
    // migrate.
    return `user\u0002${JSON.stringify(text)}\u0002${JSON.stringify(hashes)}`;
  }

  /**
   * v0.22.0 (v0220-cc, D-1 review P2) — stable per-CONVERSATION key for
   * the compaction state map: `${modelId}::<fingerprint of the FIRST
   * USER message>`. The fingerprint runs over the vision-state-
   * INDEPENDENT canonical form ({@link renderCompactionBasis}) — an
   * image committing to a marker inside the anchor message must not
   * re-key the conversation (that would reproduce the exact state-loss
   * bug this key exists to fix).
   *
   * v0220-t (CC review P3-4) — a single-message anchor, not `min(4,
   * len)` leading messages. A K-of-len head fingerprint is
   * length-unstable: the state slot is created on the conversation's
   * FIRST request (often 1-3 messages) and re-keys on every early turn
   * — a fire at len=3 wrote a 3-message key, the next turn (len>=4)
   * computed a 4-message key and silently orphaned the projection and
   * summary chain under a dead key. A single stable anchor is present
   * and identical from the conversation's first request (VS Code
   * re-sends the immutable history; growth only appends), so the key
   * never moves. Chosen over capturing the head-length at first state
   * creation because it needs no extra bookkeeping: the key stays a
   * pure function of (modelId, history).
   *
   * v0220-t2 (review follow-up T2) — the anchor is the first
   * role:'user' message (fallback: messages[0] for degenerate histories
   * with no user message), NOT messages[0]: production histories may
   * lead with a per-client SYSTEM prompt, and two same-model windows
   * with a byte-identical leading system prompt (same client, same
   * default prompt — plausible) collapsed into ONE slot, recreating
   * exactly the interleaved-window clobbering CC P2 fixed: each
   * alternation dropped the other window's projection and re-fired
   * (bounded: fresh-fire cadence with orphaned store blocks, never
   * wrong data served — but a real regression class). The first user
   * message is the first conversation-SPECIFIC content.
   *
   * Honest trade-off ledger (both classes named):
   *   1. A same-model collision requires byte-identical FIRST USER
   *      messages (e.g. two windows pasting the same prompt) — far
   *      rarer than identical leading system prompts, and the
   *      per-request basis validation inside `compactIfNeeded` bounds
   *      the damage: the foreign projection is dropped and the
   *      colliding conversation re-fires fresh. Degradation, never
   *      corruption.
   *   2. A history with NO user message at all (system-only or empty)
   *      falls back to messages[0] (or the constant `''` for an empty
   *      history — fingerprint of the empty string; compaction no-ops
   *      on it anyway), so degenerate histories share one slot only
   *      among themselves.
   */
  private conversationKey(modelId: string, openaiMessages: readonly OpenAICompatibleMessage[]): string {
    const anchor =
      openaiMessages.find((m) => m.role === 'user') ?? openaiMessages[0];
    return `${modelId}::${fingerprintText(anchor === undefined ? '' : this.memoizedBasisRender(anchor))}`;
  }

  /**
   * v0220-cc P2 — LRU get for {@link compactionStates}: a hit refreshes
   * the entry's recency (Map iteration order = insertion order; delete
   * + re-insert moves it to the newest end).
   */
  private getCompactionState(key: string): CompactionState<OpenAICompatibleMessage> | undefined {
    const hit = this.compactionStates.get(key);
    if (hit !== undefined) {
      this.compactionStates.delete(key);
      this.compactionStates.set(key, hit);
    }
    return hit;
  }

  /**
   * v0220-cc P2 — LRU set for {@link compactionStates}: writes the
   * entry as newest, then evicts the oldest entries beyond
   * {@link COMPACTION_STATES_MAX} so abandoned conversations (closed
   * windows) garbage-collect instead of accumulating projection +
   * chain state forever.
   */
  private setCompactionState(key: string, state: CompactionState<OpenAICompatibleMessage>): void {
    this.compactionStates.delete(key);
    this.compactionStates.set(key, state);
    while (this.compactionStates.size > OllamaCloudChatProvider.COMPACTION_STATES_MAX) {
      const oldest = this.compactionStates.keys().next().value;
      if (oldest === undefined) break;
      this.compactionStates.delete(oldest);
    }
  }

  /** v0220-cc P3-b — memoized wire render (see {@link wireRenderMemo}). */
  private memoizedWireRender(m: OpenAICompatibleMessage): string {
    let s = this.wireRenderMemo.get(m);
    if (s === undefined) {
      s = JSON.stringify(m);
      this.wireRenderMemo.set(m, s);
    }
    return s;
  }

  /** v0220-cc P3-b — memoized basis render (see {@link basisRenderMemo}). */
  private memoizedBasisRender(m: OpenAICompatibleMessage): string {
    let s = this.basisRenderMemo.get(m);
    if (s === undefined) {
      s = this.renderCompactionBasis(m);
      this.basisRenderMemo.set(m, s);
    }
    return s;
  }

  /**
   * v0.13.0 Slice 2 — runs one compaction check over the OpenAI-format
   * history when `ollamaCloud.compaction.enabled` is on (default ON
   * since v0.19.0, ArchCom 2026-09-15 T2). Returns the messages to
   * send onward: the compacted array on fire, the input array
   * otherwise. Called BEFORE the ADR 0007 context filter and endpoint
   * dispatch, so the filter runs on the COMPACTED list and the
   * injected summary message (a `role:'system'` OpenAI message) flows
   * through every endpoint unchanged.
   *
   * v0.21.0 (slice d1, stickiness): after a fire the compacted
   * projection is remembered per model id and RE-APPLIED to every
   * subsequent request whose history still carries the evicted prefix
   * basis (see `compaction.ts`); the returned array on such requests
   * is the re-applied projection, not the raw input.
   *
   * Unknown-window safe path (ArchCom invariant 4): when the model's
   * window is unknown (`maxInputTokens` missing/non-positive),
   * compaction does NOT fire — the hysteresis has no denominator and
   * an arbitrary split would evict context the model may still need.
   * A one-time warning is surfaced instead.
   *
   * Fallback contract: NEVER throws — a summarizer/store failure logs
   * a warning and returns the uncompacted history (the filter path
   * may still truncate; that is the accepted degradation).
   */
  private async maybeCompact(
    openaiMessages: OpenAICompatibleMessage[],
    model: ModelDefinition,
    modelId: string,
    client: OllamaClient,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<OpenAICompatibleMessage[]> {
    const config = vscode.workspace.getConfiguration('ollamaCloud');
    if (!config.get<boolean>('compaction.enabled', true)) {
      // v0.19.0 — the default is ON (package.json); reaching here
      // means the user explicitly opted out. The pre-v0.19
      // context-inflation warning (RCA 2026-08-19) still applies:
      // surface a ONE-TIME-per-session warning so the user knows their
      // context is growing unbounded and can re-enable compaction.
      this.warnContextInflationIfNeeded(model, modelId, openaiMessages, progress);
      return openaiMessages;
    }
    // ArchCom 2026-09-15 (invariant 4) — unknown-window safe path:
    // no window → no compaction, ever. `compactIfNeeded` would
    // otherwise treat 75% of 0/undefined as a trivially-reached
    // threshold and evict against a nonsense denominator.
    const windowTokens = model.maxInputTokens;
    if (!windowTokens || windowTokens <= 0) {
      if (!this.contextInflationWarned.has(`${modelId}:unknown-window`)) {
        this.contextInflationWarned.add(`${modelId}:unknown-window`);
        logger.warn(
          `Compaction: model window unknown for ${modelId} (maxInputTokens=${model.maxInputTokens}) — compaction will not fire. The context filter may still truncate.`,
        );
      }
      return openaiMessages;
    }
    const store = this.getOrCreateCompactionStore();
    if (!store) {
      logger.warn(
        'Compaction: enabled but globalStorage is unavailable — skipping compaction.',
      );
      return openaiMessages;
    }
    try {
      // v0220-cc P2 — per-CONVERSATION state: two windows alternating
      // the same model must not clobber each other's projection and
      // summary chain. The key fingerprints the conversation head
      // (vision-state-independent, so image commits keep the key).
      const convKey = this.conversationKey(modelId, openaiMessages);
      const state: CompactionState<OpenAICompatibleMessage> =
        this.getCompactionState(convKey) ?? {
          armed: true,
          lastSummary: null,
          lastPointer: null,
          lastFiredAt: null,
          projection: null,
        };
      const charsPerToken =
        this.charsPerTokenEMA.get(model.apiModel ?? model.id) ??
        OllamaCloudChatProvider.CHARS_PER_TOKEN_DEFAULT;
      const summarizerModel = config.get<string>(
        'compaction.model',
        'gpt-oss:20b',
      );
      const summarizer = createSummarizer({
        model: summarizerModel,
        request: (body, signal) => client.nativeChatOnce(body, signal),
      });
      // Slice 1.1 — cap the evicted block to 25% of the summarizer's
      // OWN window when the catalog knows the model (self-compaction
      // loop protection; unknown summarizer models omit the cap).
      const summarizerWindowTokens = this.modelCatalog
        .list()
        .find((m) => m.apiModel === summarizerModel)?.maxInputTokens;
      // v0220-cc P3-b — computed through the memoized wire render so
      // the check line shares the per-message stringify with the
      // compactIfNeeded estimates instead of adding one more
      // full-history pass.
      const usedTokensDebug = openaiMessages.reduce((s, m) => s + Math.ceil(this.memoizedWireRender(m).length / charsPerToken), 0);
      const hadProjection = state.projection != null;
      const result = await compactIfNeeded<OpenAICompatibleMessage>({
        messages: openaiMessages,
        windowTokens: model.maxInputTokens,
        charsPerToken,
        state,
        summarize: summarizer,
        store,
        render: (m) => this.memoizedWireRender(m),
        // v0220-cc P2 — basis fingerprints are computed over the
        // vision-state-INDEPENDENT canonical form so a raw→marker
        // transition inside the evicted prefix cannot drop the
        // projection (whiplash). The wire render above is unchanged.
        // v0220-cc P3-b — both renders memoized per message object.
        basisRender: (m) => this.memoizedBasisRender(m),
        ...(summarizerWindowTokens !== undefined
          ? { summarizerWindowTokens }
          : {}),
      });
      // v0.21.0 d1 — persist the post-check state ALWAYS, not only on
      // fires: passthrough results now carry meaningful transitions
      // (projection invalidation resets, re-arm re-evaluations on the
      // re-applied usage) that must survive to the next request.
      // v0220-cc P2 — persisted under the conversation key (LRU).
      this.setCompactionState(convKey, result.state);
      // P3-b (d1 rider) — per-request check line at INFO level. The
      // old line was logger.debug and invisible in the field with
      // debug=false; every number is already computed, so one cheap
      // line per request buys the RCA data the 2026-10-02 incident
      // lacked. `reapply` distinguishes "projection remembered and
      // re-applied" (true/false) from "no projection in play" (n/a).
      // v0220-cc P2 — `conv` carries the conversation-key fingerprint
      // so interleaved windows are tellable apart in field logs.
      // v0220-cc P3-a — the token number is renamed `rawUsedTokens=`:
      // it is the estimate over the RAW incoming history, while the
      // fire/re-apply gate inside compactIfNeeded operates on the
      // PROJECTED (re-applied) usage — the old `usedTokens=` label
      // invited reading it as the gate's number (D-1 review P3).
      logger.info(
        `Compaction check: rawUsedTokens=${usedTokensDebug} windowTokens=${model.maxInputTokens} threshold=${Math.floor(0.75 * model.maxInputTokens)} charsPerToken=${charsPerToken} armed=${result.state.armed} reapply=${hadProjection ? String(result.reapplied) : 'n/a'} conv=${convKey.split('::')[1] ?? '?'}`,
      );
      if (result.reapply) {
        // d1 stickiness observability — distinct from the fire line so
        // field logs show WHICH mechanism served the request.
        logger.info(
          `Compaction re-applied: projectedTokens=${result.reapply.projectedTokens} tailMessages=${result.reapply.tailMessages} (cooldown-held new fire skipped)`,
        );
      }
      if (result.droppedProjection) {
        logger.info(
          'Compaction projection dropped: incoming history no longer matches the compacted basis (new session or pruned turns) — hysteresis reset.',
        );
      }
      if (!result.compacted) {
        // d1 — a re-applied projection must be served even though no
        // new fire happened; plain passthrough returns the raw input.
        return result.reapplied ? result.messages : openaiMessages;
      }
      const stats = result.stats;
      logger.info(
        `Compaction: before=${stats?.beforeTokens} after=${stats?.afterTokens} tokens evicted=${stats?.evictedMessages} capped=${stats?.capped} pointer=${result.pointer}`,
      );
      // P3-a (d1 rider) — compaction notice WITHOUT polluting the
      // assistant text. The previous `LanguageModelTextPart` banner
      // landed verbatim inside the assistant's message content in the
      // chat UI and transcript (field-verified 2026-10-02). This API
      // version (1.118) has no dedicated progress/status part; of the
      // `LanguageModelResponsePart` alternatives, tool parts are
      // semantically wrong and `LanguageModelDataPart` is the clean
      // one: an `application/json` data part rides the response stream
      // (readable by programmatic consumers) but has no markdown
      // renderer in the chat transcript, so it never becomes assistant
      // text. The durable human-readable record stays the
      // `Compaction: before=… after=…` INFO line above.
      // v0220-cc P3-d — built via the static `LanguageModelDataPart.json`
      // factory (present in @types/vscode 1.118 and the test stub):
      // same bytes as the hand-rolled TextEncoder payload, minus the
      // hand-rolling.
      progress.report(
        vscode.LanguageModelDataPart.json(
          {
            notice: 'context-compacted',
            beforeTokens: stats?.beforeTokens ?? null,
            afterTokens: stats?.afterTokens ?? null,
          },
          'application/json',
        ),
      );
      return result.messages;
    } catch (error) {
      logger.warn(
        'Compaction: summarizer failed — proceeding with uncompacted context (the context filter may still truncate).',
        error,
      );
      return openaiMessages;
    }
  }

  /**
   * v0.12.1 — context-inflation warning (RCA 2026-08-19, ADR 0007
   * complement), reworded for the v0.19.0 default flip (ArchCom
   * 2026-09-15 T2). Reached ONLY when the user explicitly set
   * `compaction.enabled=false` (the shipped default is ON): when the
   * conversation exceeds 75% of the model's window, surface a
   * one-time-per-session warning so the user knows their context is
   * growing unbounded and can re-enable compaction before hitting the
   * provider's hard context-window ceiling.
   *
   * The warning fires at most once per `modelId` per session (tracked
   * in {@link contextInflationWarned}) to avoid spamming on every turn.
   * It uses `progress.report` (visible in the chat UI as a streaming
   * annotation) + `logger.warn` (visible in diagnostics). It does NOT
   * enable compaction — that remains the user's decision.
   *
   * Token estimate mirrors `compaction.ts`: `charsPerToken` from the
   * EMA (or the 4-char default), applied to the OpenAI-format request
   * char count. The 75% threshold matches `COMPACT_AT_RATIO`.
   */
  private warnContextInflationIfNeeded(
    model: ModelDefinition,
    modelId: string,
    openaiMessages: OpenAICompatibleMessage[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (this.contextInflationWarned.has(modelId)) {
      return;
    }
    const windowTokens = model.maxInputTokens;
    if (!windowTokens || windowTokens <= 0) {
      return;
    }
    const charsPerToken =
      this.charsPerTokenEMA.get(model.apiModel ?? model.id) ??
      OllamaCloudChatProvider.CHARS_PER_TOKEN_DEFAULT;
    const requestChars = countOpenAIRequestChars(openaiMessages);
    const usedTokens = Math.ceil(requestChars / charsPerToken);
    const fireThreshold = Math.floor(0.75 * windowTokens);
    if (usedTokens < fireThreshold) {
      return;
    }
    this.contextInflationWarned.add(modelId);
    const pct = Math.round((usedTokens / windowTokens) * 100);
    const warning =
      `⚠️ Context at ${pct}% of the ${model.name} window (${usedTokens.toLocaleString()}/${windowTokens.toLocaleString()} tokens). ` +
      'Compaction is currently DISABLED (ollamaCloud.compaction.enabled=false) — re-enable it to summarize older turns and stay under the limit. ' +
      'Without compaction, long conversations may hit the provider hard ceiling.';
    logger.warn(
      `Context inflation: ${modelId} at ${pct}% of window (${usedTokens}/${windowTokens} tokens, ${openaiMessages.length} messages) — compaction disabled by user setting (default is ON since v0.19.0). Set ollamaCloud.compaction.enabled=true to re-enable.`,
    );
    progress.report(new vscode.LanguageModelTextPart(warning));
  }

  /**
   * ArchCom 0011c Fix 5 — collects a diagnostic snapshot for bug
   * reports. Gathers extension version, connection count, model count,
   * capability cache state, and recent logger errors into a markdown
   * document opened in a new editor tab. All output is run through
   * {@link redactSensitive} as defence-in-depth.
   */
  async collectDiagnostics(): Promise<void> {
    const extensionVersion =
      vscode.extensions.getExtension('Korrnals.ollama-cloud-provider')?.packageJSON
        ?.version ?? 'unknown';
    const connections = loadConnections();
    const models = this.modelCatalog.list();
    const cacheSnapshot = getCapabilityCacheSnapshot();
    const recentErrors = logger.getRecentErrors();

    const connectionLines = connections.length > 0
      ? connections.map((c) => `- \`${c.id}\` (${c.type}${c.enabled ? '' : ', disabled'})`).join('\n')
      : '- none';
    const cacheLines = cacheSnapshot.connections.length > 0
      ? cacheSnapshot.connections.map(
          (c) =>
            `- \`${c.connectionId}\`: responses=${c.responsesAvailable}, chat=${c.chatAvailable}, native=${c.nativeChatAvailable}${c.expired ? ' (expired)' : ''}`,
        ).join('\n')
      : '- empty';
    const retiredLines = cacheSnapshot.retiredModels.length > 0
      ? cacheSnapshot.retiredModels.map((m) => `- \`${m}\``).join('\n')
      : '- none';
    const errorLines = recentErrors.length > 0
      ? recentErrors.map((line) => redactSensitive(line)).join('\n')
      : '- none';

    const markdown = redactSensitive(`# Ollama Cloud — Diagnostics

Generated: ${new Date().toISOString()}

## Extension
- Version: \`${extensionVersion}\`
- VS Code: \`${vscode.version}\`

## Connections (${connections.length})
${connectionLines}

## Models (${models.length})
${models.map((m) => `- \`${m.id}\` (connection: \`${m.connectionId}\`)`).join('\n') || '- none'}

## Capability cache
${cacheLines}

### Retired models
${retiredLines}

## Recent errors/warnings (last ${recentErrors.length})
${errorLines}
`);

    const doc = await vscode.workspace.openTextDocument({
      content: markdown,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);
    logger.info('Diagnostics collected and opened in a new editor tab.');
  }

  /**
   * ADR 0006 — runs a streaming client (`streamChat` or
   * `streamResponses`) and resolves when the client calls `onDone`,
   * rejects when it calls `onError`. Both clients use the same
   * `StreamCallbacks` interface (see `protocolTypes.ts`) and never
   * resolve their returned promise with a value — termination is
   * signalled via the callbacks. This helper bridges that callback
   * contract to `async`/`await` at the call site.
   *
   * `onSuccess` runs after `onDone` fires and BEFORE the promise
   * resolves — used by the `/v1/responses` path to memoize
   * capability (`markResponsesAvailable`) only on a clean completion,
   * not on a fallback that re-throws.
   *
   * Structured reasoning: `onThinking` → `LanguageModelThinkingPart`
   * when the API is present (VS Code 1.103+), otherwise the part is
   * silently dropped — the `/chat/completions` client never emits
   * `onThinking`, so this only fires on the `/v1/responses` path.
   */
  private async runStream(
    invoke: (
      callbacks: import('./protocolTypes.js').StreamCallbacks,
    ) => Promise<void>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    model: ModelDefinition,
    requestChars: number,
    onSuccess: (() => void) | undefined,
  ): Promise<void> {
    // Issue #41 — Strand 1: stream lifecycle logging. Record the
    // request start time so stream-start (first chunk) and stream-done
    // can report elapsed ms. The endpoint label is derived from the
    // model's connection at the call site would require plumbing; the
    // model id + apiModel is enough signal for diagnostics.
    const startedAt = Date.now();
    let firstChunkAt: number | undefined;
    let chunkCount = 0;
    const modelLabel = model.apiModel ?? model.id;
    // ArchCom 2026-09-14 §3.4 — commit-window. The first ~5 s of deltas
    // are buffered before they reach `progress` (window measured from
    // the FIRST delta, so slow-TTFT thinking adds no invisible time).
    // A break inside the window is retried silently by the stream
    // reader (buffer reset — no duplicate prefix, no flicker); after
    // the flush the stream is final (terminal CIE). The window wraps
    // the callbacks HERE because the clients' `processLine` closures
    // invoke whatever callbacks object this method passes to `invoke`;
    // the controller rides on the wrapped object and is discovered by
    // `readStream`. Hidden-retry count goes into the report lines below
    // (diagnostics disclosure of otherwise-silent retries).
    const commitWindow = createCommitWindow();
    // Review fix P3-1 (commit-window remediation) — one terminal-error
    // log line per stream, covering BOTH surfacing paths: the onError
    // callback AND thrown errors that reject via the safety-net catch
    // (a terminal ConnectionInterruptedError after the window is
    // THROWN by readStream, never passes through onError, and used to
    // bypass this log entirely). The guard flag prevents a duplicate
    // line when a client both calls onError and rejects its promise.
    let terminalErrorLogged = false;
    const logStreamError = (error: Error): void => {
      if (terminalErrorLogged) {
        return;
      }
      terminalErrorLogged = true;
      const durationMs = Date.now() - startedAt;
      const status =
        error instanceof HttpError ? ` status=${error.status}` : '';
      const ref = errorRefId(error);
      logger.error(
        `Stream error: model="${modelLabel}" duration=${durationMs}ms${status} class=${error.constructor.name} commitWindowHiddenRetries=${commitWindow.controller.hiddenRetryCount()} ref=${ref}`,
        error,
      );
    };
    await new Promise<void>((resolve, reject) => {
      void invoke(commitWindow.wrap({
        onText: (text: string) => {
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            // Issue #41 — Strand 1: log stream start (first chunk) with
            // time-to-first-token. One line per stream — not per chunk.
            // Commit-window note: with buffering in place this fires at
            // FLUSH time, so ttft is time-to-first-VISIBLE-token.
            logger.info(
              `Stream start: model="${modelLabel}" ttft=${firstChunkAt - startedAt}ms`,
            );
          }
          chunkCount += 1;
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onThinking: (text: string) => {
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            logger.info(
              `Stream start (thinking): model="${modelLabel}" ttft=${firstChunkAt - startedAt}ms`,
            );
          }
          // Issue #41 review fix (Finding 2): increment `chunkCount`
          // here too, so a thinking-only stream does not log
          // `chunks=0` (which misreads as "stream empty").
          chunkCount += 1;
          const thinkingPart = createThinkingPart(text);
          if (thinkingPart) {
            progress.report(thinkingPart);
          }
        },
        onToolCall: (toolCall: {
          id: string;
          name: string;
          input: Record<string, unknown>;
        }) => {
          if (firstChunkAt === undefined) {
            firstChunkAt = Date.now();
            logger.info(
              `Stream start (tool_call): model="${modelLabel}" ttft=${firstChunkAt - startedAt}ms`,
            );
          }
          // Issue #41 review fix (Finding 2): increment `chunkCount`
          // here too, so a tool-call-only stream does not log
          // `chunks=0` (which misreads as "stream empty").
          chunkCount += 1;
          progress.report(
            new vscode.LanguageModelToolCallPart(
              toolCall.id,
              toolCall.name,
              toolCall.input,
            ),
          );
        },
        onUsage: (usage: UsageInfo) => {
          // Issue #41 review fix (Finding 3): capture `charsPerToken`
          // BEFORE updating the EMA. The audit compares "what we sent"
          // against "what the server counted" using the estimator's
          // state AT REQUEST TIME. Updating first then logging the
          // already-shifted EMA is self-referential bias that dampens
          // the delta for the first few requests of a session.
          // Fix 3 — the EMA is now per-model; read this model's value.
          const apiModel = model.apiModel ?? model.id;
          const preUpdateCharsPerToken =
            this.charsPerTokenEMA.get(apiModel) ??
            OllamaCloudChatProvider.CHARS_PER_TOKEN_DEFAULT;
          this.updateTokenEstimate(requestChars, usage, apiModel);
          // Issue #41 — Strand 3.2: log estimated tokens alongside
          // server-reported usage so the audit can compare "what we
          // sent" vs "what the server counted". Log the delta when it
          // exceeds 20% — that is the signal of redundant content or
          // a conversion bug.
          logger.info(
            formatUsageLog(model.id, usage, requestChars, preUpdateCharsPerToken),
          );
        },
        onDone: () => {
          // Issue #41 — Strand 1: log stream done with total duration
          // + chunk count. Diagnostics for slow streams and to confirm
          // a request actually completed (vs silently dropped). The
          // commit-window hidden-retry count discloses how many
          // silent in-window retries the message needed (ArchCom §3.4
          // diagnostics requirement).
          const durationMs = Date.now() - startedAt;
          logger.info(
            `Stream done: model="${modelLabel}" duration=${durationMs}ms chunks=${chunkCount} commitWindowHiddenRetries=${commitWindow.controller.hiddenRetryCount()}`,
          );
          onSuccess?.();
          resolve();
        },
        onError: (error: Error) => {
          // Issue #41 — Strand 1: log stream error with the error
          // class + status (if HttpError) + duration. One line per
          // failed stream — not per retry (retries log in retry.ts).
          // v0.12.0 Item 2 — append the stable ref id so the logged
          // stack trace can be correlated to the user-facing message
          // (which carries the same ref via `classifyStreamError`).
          // The ref is generated here (not in `classifyStreamError`)
          // so it is available in the log even when the error is later
          // re-classified or re-wrapped by the caller.
          // P3-1: the logging itself lives in logStreamError (shared
          // with the thrown-error path, duplicate-guarded).
          logStreamError(error);
          reject(error);
        },
        // ArchCom 2026-09-14 — surface VISIBLE stream notices inline:
        // the zero-byte extra attempt announcement (§3.4; nothing has
        // been shown yet, but the user must know why they are waiting
        // longer). In-window hidden retries never call onNotice — they
        // are disclosed via diagnostics only.
        onNotice: (text: string) => {
          progress.report(new vscode.LanguageModelTextPart(text));
        },
      })).catch((error: unknown) => {
        // Safety net: if the client rejects its own promise instead
        // of calling onError (shouldn't happen, but defence-in-depth),
        // surface it as a rejection so the caller's try/catch fires.
        // P3-1: a thrown terminal error (post-window CIE, budget
        // exhaustion) NEVER passes through onError — log it here so
        // every failed stream leaves exactly one `Stream error` line
        // (logStreamError is duplicate-guarded against the onError
        // path). Flush the commit-window first: a thrown terminal
        // error must not discard already-received tokens the user was
        // billed for.
        commitWindow.controller.flush();
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        logStreamError(normalized);
        reject(normalized);
      });
    });
  }
}

function toChatInformation(
  model: ModelDefinition,
  hasApiKey: boolean,
  connection: ConnectionConfig | undefined,
): vscode.LanguageModelChatInformation {
  const configurationSchema = getModelConfigurationSchema(model);

  // Origin label prefix — `Cloud:`, `Local:`, `VPS:`, `custom:`. Cloud
  // connection keeps the bare model name for backward compatibility
  // (existing test assertions check `name` without a prefix). Non-
  // cloud connections prepend the origin label so the picker shows
  // which connection a model came from.
  const name =
    model.origin === 'Cloud'
      ? model.name
      : `${model.origin}:${model.name}`;

  // Issue #41 — Strand 2: surface the effective endpoint in the
  // tooltip. Appended as a new line so the existing `PROVIDER_TOOLTIP`
  // header and the auth-required hint stay where existing readers
  // expect them; the endpoint line is pure diagnostic, no host/auth.
  const endpointLabel = resolveEndpointLabel(connection);
  const baseTooltip = hasApiKey
    ? PROVIDER_TOOLTIP
    : `${PROVIDER_TOOLTIP}\n${AUTH_REQUIRED_DETAIL}`;
  const tooltip = `${baseTooltip}\nEndpoint: ${endpointLabel}`;

  // v0.12.1 — vision fallback capability advertisement (RCA 2026-08-19,
  // ADR 0004). Copilot Chat pre-filters image attachments by the
  // declared `imageInput` capability: a model that declares `false`
  // never receives image parts — the extension cannot detect them,
  // and ADR 0004 vision fallback becomes architecturally impossible.
  //
  // Fix: when `visionFallback.enabled` is true, advertise `imageInput:
  // true` for text-only models so Copilot Chat passes the image
  // through. The internal `ModelDefinition.capabilities.imageInput`
  // (used by `resolveVisionSupport` + `shouldFallback`) stays `false`,
  // so the vision gate in `provideLanguageModelChatResponse` still
  // detects the mismatch and routes to the vision model via
  // `executePassThrough`. This is a capability ADVERTISEMENT change,
  // not a model capability change — the primary model still cannot
  // handle images; the extension intercepts before the primary is
  // called.
  //
  // When fallback is disabled, the advertised capability stays `false`
  // (pre-v0.12.1 behaviour): Copilot Chat clips images, and the gate
  // never fires. The user sees no error because no image arrives.
  const fallbackEnabled = vscode.workspace
    .getConfiguration('ollamaCloud')
    .get<boolean>('visionFallback.enabled', false);
  const advertisedImageInput =
    model.capabilities.imageInput || fallbackEnabled;

  return {
    id: model.id,
    name,
    family: model.family,
    version: model.version,
    detail: model.origin === 'Cloud' ? PROVIDER_TOOLTIP : model.origin,
    tooltip,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: {
      imageInput: advertisedImageInput,
      toolCalling: model.capabilities.toolCalling,
    },
    isUserSelectable: true,
    isBYOK: true,
    statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
    ...(configurationSchema ? { configurationSchema } : {}),
  } as ModelPickerInformation;
}



// Issue #41 — Strand 3.2: exported so the unit test in
// `test/unit/formatUsageLog.test.ts` can assert the estimatedTokens /
// delta audit fields without going through the full provider stream.
export function formatUsageLog(
  modelId: string,
  usage: UsageInfo,
  requestChars?: number,
  charsPerToken?: number,
): string {
  const parts = [`[${modelId}]`];
  if (usage.inputTokens !== undefined) {
    parts.push(`input=${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`output=${usage.outputTokens}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`total=${usage.totalTokens}`);
  }

  // Issue #41 — Strand 3.2: token audit. When the caller passes the
  // request's character count and the current chars-per-token estimate,
  // compute the locally-estimated input token count and compare it
  // against the server-reported `inputTokens`. A delta >20% in either
  // direction is the signal of redundant content (system prompt sent
  // twice, instructions duplicated in `instructions` + a message, tool
  // definitions sent in both `tools` and inline) or a conversion bug.
  // The audit line stays single-line — `logger.info` is one call.
  if (
    requestChars !== undefined &&
    charsPerToken !== undefined &&
    charsPerToken > 0
  ) {
    const estimatedTokens = Math.max(1, Math.ceil(requestChars / charsPerToken));
    parts.push(`estimatedTokens=${estimatedTokens}`);

    if (usage.inputTokens !== undefined && usage.inputTokens > 0) {
      const diff = estimatedTokens - usage.inputTokens;
      const ratio = Math.abs(diff) / usage.inputTokens;
      if (ratio > 0.2) {
        // Sign the delta: `+` when the estimate OVER-counts (likely
        // redundant content sent), `-` when the server counted more
        // than we estimated (likely under-counting in the convert
        // path, e.g. a part dropped before reaching the server).
        const sign = diff > 0 ? '+' : '-';
        const pct = Math.round(ratio * 100);
        parts.push(
          `delta=${sign}${pct}% (audit: check convert path for redundancy)`,
        );
      }
    }
  }

  return parts.join(' ');
}

function createThinkingPart(
  text: string,
): vscode.LanguageModelResponsePart {
  // ADR 0006 Phase 3 — structured reasoning. Prefer
  // `LanguageModelThinkingPart` when the API is present (VS Code
  // 1.103+). On older VS Code versions where the class is absent,
  // fall back to `LanguageModelTextPart` so the reasoning content
  // is still surfaced to the user rather than silently dropped.
  const vscodeWithThinking = vscode as typeof vscode & {
    LanguageModelThinkingPart?: new (
      value: string,
    ) => vscode.LanguageModelResponsePart;
  };

  if (typeof vscodeWithThinking.LanguageModelThinkingPart === 'function') {
    return new vscodeWithThinking.LanguageModelThinkingPart(text);
  }

  return new vscode.LanguageModelTextPart(text);
}
