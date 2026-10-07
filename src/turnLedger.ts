/**
 * v0220 P2 (slice v0212-p2-turncontext-extraction) — TurnLedger: the
 * ONE owner of the vision turn-scoped bookkeeping that used to live as
 * six scattered provider instance fields whose interaction was only
 * expressible in comments (sentImageHashes, failedImageSendCounts,
 * cappedImageHashes, visionResendCapWarned, the per-turn
 * pendingImageHashes container). Extracted verbatim from
 * `OllamaCloudChatProvider` — pure refactor, semantics byte-identical
 * for ALL request shapes (sequential AND concurrent) after rework
 * P2-1; the suite incl. the ADR 0013 lifecycle, D-3 raw-resend and
 * the interleaved-turn isolation pins is the safety net.
 *
 * Two lifetimes, one ledger:
 *   - INSTANCE-level (per provider, per window/session): the
 *     sent/failed/capped maps + the WARN-once latch. Constructed once
 *     as a provider field; a window reload re-creates it (each image
 *     re-sends once per session — the accepted posture, see
 *     visionHistory.ts).
 *   - TURN-level: the {@link TurnHandle} minted by {@link beginTurn}
 *     at the top of every `provideLanguageModelChatResponse` CALL.
 *     The handle is CALL-LOCAL state — exactly the lifetime of the
 *     original `const pendingImageHashes = new Set()` local — so
 *     concurrent requests are fully isolated (B's turn can never wipe
 *     or commit A's pending hashes). ONLY the attempt whose stream
 *     genuinely resolved commits the handle's hashes
 *     ({@link commitTurn}); a turn that ends without its stream
 *     completing routes them into the failed-send counter instead
 *     ({@link recordFailedTurn}).
 *
 * Contract (unchanged since extraction):
 *   - commit-on-success (v0.20.1): a failed/cancelled turn must NOT
 *     record hashes — the model never saw the image, so the next turn
 *     re-sends it RAW;
 *   - quiet-completed cancel (v0.21.0 D-2/D-3): `onDone` resolves the
 *     pipeline even for a cancel with nothing user-visible — the
 *     cancelled token at commit time routes the pending hashes to the
 *     failed-send counter instead of the sent set (cap > 0), or
 *     commits them (cap = 0 legacy commit-on-resolve);
 *   - raw-resend cap (v0.21.0 D-3): after `rawResendCap` failed sends
 *     a hash degrades permanently (per session) to the never-sent
 *     marker, capping the ~2M-chars-per-turn resend amplifier.
 */

import * as vscode from 'vscode';
import { logger } from './logger.js';
import {
  applyVisionHistoryLifecycle,
  resolveRawResendCap,
} from './visionHistory.js';

/**
 * The per-turn PENDING hash container, minted by
 * {@link TurnLedger.beginTurn} — one per
 * `provideLanguageModelChatResponse` call (call-local lifetime; see
 * the ledger's module docblock for the concurrency contract). Opaque
 * by convention: callers hold it and hand it back to the ledger; they
 * never read or mutate the set directly.
 */
export interface TurnHandle {
  readonly pendingImageHashes: Set<string>;
}

export class TurnLedger {
  /**
   * ADR 0013 lifecycle — hashes already sent RAW to any model this
   * session (per provider instance, in-memory; a window reload
   * re-sends each image once). Written ONLY via {@link commitTurn},
   * which the dispatch success path calls AFTER `runStream` resolved
   * (= `onDone` fired). A failed/cancelled turn must NOT record
   * hashes: the model never saw the image, so the next turn re-sends
   * it RAW (RCA 2026-09-25: a DNS-killed turn recorded the hash, and
   * the retry turn shipped a marker instead of the image — the model
   * never saw it at all).
   */
  private readonly sentImageHashes = new Set<string>();
  /**
   * v0.21.0 D-3 (owner-ratified 2026-10-02) — per-hash count of FAILED
   * raw sends (turn ended without its stream genuinely completing).
   * Caps the resend amplifier: v0.20.1 commit-on-success correctly
   * leaves a failed turn's hashes uncommitted, but that made every
   * subsequent turn re-send those images as RAW base64 — one failed
   * screenshot turn re-uploaded ~2M chars per turn until a success
   * landed (3.3M-char requests observed), tripping over-window
   * compaction and mass eviction. When a count reaches
   * `ollamaCloud.visionHistory.rawResendCap` (default 3), the hash
   * moves to {@link cappedImageHashes} and degrades to the never-sent
   * marker for the rest of the session. In-memory per instance (same
   * lifetime as {@link sentImageHashes}); a successful commit deletes
   * the entry (committed hashes are exempt forever).
   */
  private readonly failedImageSendCounts = new Map<string, number>();
  /**
   * v0.21.0 D-3 — hashes that exhausted the raw-resend cap, mapped to
   * the attempt count that capped them (rendered into the marker
   * note). Permanent for the session; never re-sent raw, never
   * committed into {@link sentImageHashes}.
   */
  private readonly cappedImageHashes = new Map<string, number>();
  /** v0.21.0 D-3 — WARN-once-per-session latch for the first capped hash. */
  private visionResendCapWarned = false;

  /**
   * v0.20.1 (commit-on-success) — the per-turn PENDING hash container.
   * {@link TurnLedger.beginTurn} mints ONE handle per
   * `provideLanguageModelChatResponse` CALL — exactly the lifetime of
   * the original `const pendingImageHashes = new Set()` local.
   * `applyVisionHistoryLifecycle` records first-send hashes into the
   * HANDLE, not into {@link sentImageHashes}; only the attempt whose
   * stream genuinely resolved commits them ({@link commitTurn}); a
   * turn that ends without completing routes them into the failed-send
   * counter instead ({@link recordFailedTurn}). A 404 fallback that
   * retries a second endpoint within the SAME request shares the one
   * handle.
   *
   * Rework P2-1 (falsified 2026-10-02, fix-then-ship): the first
   * extraction stored this as a shared per-INSTANCE field reset by
   * `beginTurn()` — under VS Code's PARALLEL provider calls
   * (multi-participant chats, background title generation), request
   * B's `beginTurn()` wiped in-flight request A's pending set (A
   * under-committed → raw re-send amplifier, RCA-class 2026-09-25)
   * and A's commit committed B's not-yet-sent hashes (broken
   * commit-on-success). The handle restores call-local isolation:
   * concurrent requests each hold their own container and cannot
   * touch each other's turn state; only the INSTANCE-level maps above
   * are shared (per-window session state, as before).
   */
  beginTurn(): TurnHandle {
    return { pendingImageHashes: new Set<string>() };
  }

  /**
   * v0.22.3 (task v0223-vision-cache-warm, D3) — read-only membership
   * probe over {@link sentImageHashes}: "was this image ALREADY sent
   * RAW to some model this session (and its turn genuinely completed)?"
   *
   * Consumer: the provider's two-phase vision gate. When the user
   * switches mid-session from a vision-capable primary (which served
   * the image RAW and committed the hash, but wrote NO description
   * into the persistent cache) to a text-only primary, VS Code re-sends
   * the same immutable history; the gate must know the image was
   * already SEEN so it can substitute the repeat marker (or the D1
   * warm cache) instead of describing a fresh vision call — or
   * throwing. (D1 warm-the-cache; field report 2026-10-06.)
   *
   * Deliberately narrow: the set itself is NOT exposed (the ledger
   * stays the ONE owner of the sent/failed/capped state); callers ask
   * per hash. Committed hashes only — a PENDING (in-flight) or FAILED
   * send is still invisible to the model, and the next turn must keep
   * re-sending it RAW (commit-on-success, v0.20.1).
   */
  hasBeenSent(hash: string): boolean {
    return this.sentImageHashes.has(hash);
  }

  /**
   * ADR 0013 lifecycle application — first send of a hash goes RAW,
   * repeats become in-band markers, capped hashes degrade to the
   * never-sent marker. Operates on the given turn's pending container
   * (call-local — see {@link beginTurn}); the provider does not thread
   * the three instance maps at every call site.
   */
  applyLifecycle(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    turn: TurnHandle,
  ): vscode.LanguageModelChatRequestMessage[] {
    return applyVisionHistoryLifecycle(
      messages,
      this.sentImageHashes,
      turn.pendingImageHashes,
      this.cappedImageHashes,
    );
  }

  /**
   * v0.20.1 — commits THIS turn's pending vision-lifecycle hashes into
   * the instance-level {@link sentImageHashes} set. Called ONLY on the
   * success path: after `await runStream(...)` resolved (which
   * resolves on `onDone`) or after `executePassThrough` resolved. A
   * turn that throws (error / cancel) never reaches the commit, so
   * the next turn re-sends the image RAW.
   *
   * v0.21.0 D-3 — `onDone` fires for BOTH genuine completion and the
   * D-2 quiet-completed cancel (a cancel with nothing user-visible
   * resolves the stream pipeline instead of rejecting it). The token
   * distinguishes them: a cancelled token at commit time means the
   * stream did NOT genuinely complete (the cancel listener aborts the
   * read, so a stream cannot genuinely finish while cancelled) — the
   * pending hashes count as FAILED sends for the raw-resend cap
   * instead of committing (restores the documented v0.20.1 intent
   * "a failed/cancelled turn must NOT record hashes" for the D-2
   * path). With `rawResendCap = 0` the check is skipped entirely:
   * the legacy commit-on-resolve behavior applies unchanged.
   *
   * v0223 (task v0223-vision-cache-warm, D1) — returns the hashes this
   * call actually COMMITTED (empty when there was nothing pending or
   * the cancelled-token routing sent them to the failed counter). The
   * provider's success paths hand exactly this list to the background
   * cache warmer — the hashes whose images went RAW to a model this
   * turn are the ones whose description the persistent cache should
   * hold before a text-only primary re-sends them. The set itself is
   * never exposed (D3): this is a one-shot, already-committed snapshot.
   */
  commitTurn(
    turn: TurnHandle,
    token?: vscode.CancellationToken,
  ): readonly string[] {
    const pending = turn.pendingImageHashes;
    if (pending.size === 0) {
      return [];
    }
    if (token?.isCancellationRequested && resolveRawResendCap() > 0) {
      this.recordFailedImageSends(pending);
      return [];
    }
    const committed: string[] = [];
    for (const hash of pending) {
      this.sentImageHashes.add(hash);
      // Success exempts the hash forever (never raw again) — drop any
      // stale failure count so the map does not grow unbounded.
      this.failedImageSendCounts.delete(hash);
      committed.push(hash);
    }
    pending.clear();
    return committed;
  }

  /**
   * v0.21.0 D-3 — records a FAILED raw send for every pending hash of
   * a turn that ended without its stream genuinely completing (the
   * `provideLanguageModelChatResponse` catch path, or a quiet-completed
   * cancel routed here from {@link commitTurn}). When a hash's count
   * reaches `ollamaCloud.visionHistory.rawResendCap` it moves to
   * {@link cappedImageHashes} — the next turn degrades it to the
   * never-sent marker instead of re-uploading raw base64. With
   * cap = 0 (unlimited legacy) this is a no-op beyond clearing the
   * container: no counting, no degradation, byte-identical v0.20.1
   * behavior.
   */
  recordFailedTurn(turn: TurnHandle): void {
    this.recordFailedImageSends(turn.pendingImageHashes);
  }

  /**
   * v0.21.0 D-3 — the counting/degrade engine (moved verbatim from
   * the provider). Package-private in spirit; kept `private` because
   * both entry points ({@link commitTurn} quiet-cancel routing and
   * {@link recordFailedTurn}) live in this class.
   */
  private recordFailedImageSends(pending: Set<string>): void {
    if (pending.size === 0) {
      return;
    }
    const cap = resolveRawResendCap();
    if (cap <= 0) {
      pending.clear();
      return;
    }
    for (const hash of pending) {
      const attempts = (this.failedImageSendCounts.get(hash) ?? 0) + 1;
      if (attempts >= cap) {
        this.failedImageSendCounts.delete(hash);
        this.cappedImageHashes.set(hash, attempts);
        logger.info(
          `vision resend cap reached: hash=${hash.slice(0, 8)} attempts=${attempts} — degrading to marker`,
        );
        if (!this.visionResendCapWarned) {
          this.visionResendCapWarned = true;
          // P3-d (cascade cosmetics 2026-10-02): the old advice said
          // "re-attach the image" — but cappedImageHashes keys on the
          // sha256 of the bytes, so a byte-identical re-attach silently
          // stays capped. The advice must name what actually clears the
          // cap: a MODIFIED copy (new bytes → new hash) or a window
          // reload (the sets are per-session, see sentImageHashes).
          logger.warn(
            `vision resend cap: an image (${hash.slice(0, 8)}) failed ${attempts} raw sends and stays a text marker for the rest of the session — прикрепите изменённую копию изображения или перезагрузите окно, чтобы модель его увидела; побайтово идентичная копия даёт тот же хеш и остаётся маркером до конца сессии`,
          );
        }
      } else {
        this.failedImageSendCounts.set(hash, attempts);
      }
    }
    pending.clear();
  }
}
