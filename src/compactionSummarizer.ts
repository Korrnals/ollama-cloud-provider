/**
 * v0.13.0 Slice 2 — production summarizer for context compaction
 * (spec: docs/compaction-spec.md § Slice 2).
 *
 * Wraps a single injected NON-STREAMING native `/api/chat` request
 * (the transport helper is `OllamaClient.nativeChatOnce`, injected by
 * the provider so this module stays vscode-free and testable) into
 * the `Summarizer` contract the compaction core consumes.
 *
 * Contract (binding, spec § Slice 2):
 *   - ONE call per compaction event — NEVER retries. Frequency is
 *     already capped upstream by the 5-minute rate guard in
 *     `shouldCompact`; a retry loop here would double-bill the
 *     cheap-model quota on transient failures.
 *   - Timeout default 60s via `AbortController`. The abort signal is
 *     forwarded to the injected `request` (the production transport
 *     destroys the socket on abort); as defence-in-depth the call is
 *     ALSO raced against a local timeout promise, so a `request`
 *     implementation that ignores the signal still cannot hang the
 *     compaction path past `timeoutMs`. On timeout the summarizer
 *     THROWS — the caller (provider) logs a warning and proceeds with
 *     the uncompacted history (fallback contract: compaction never
 *     fails the chat).
 *   - Request body: `{ model, messages: [user prompt], stream: false,
 *     think: false }` — non-streaming, thinking disabled (the
 *     checkpoint summary needs no chain-of-thought; `think: false`
 *     keeps the cheap model's output short and cheap).
 */

import type { Summarizer } from './compaction.js';

/** Default single-call timeout (spec: 60s). */
export const SUMMARIZER_TIMEOUT_MS_DEFAULT = 60_000;

/** Dependencies for {@link createSummarizer}. */
export interface SummarizerDeps {
  /**
   * Executes the non-streaming native `/api/chat` request and returns
   * `message.content`. Receives the ready-to-send body (unknown
   * shape — owned by this module) and the abort signal. An
   * implementation MAY ignore the signal; the local timeout race
   * still bounds the call.
   */
  request: (body: unknown, signal: AbortSignal) => Promise<string>;
  /** Cheap model used ONLY for context summarization, not for chat. */
  model: string;
  /** Single-call timeout in ms (default 60 000). */
  timeoutMs?: number;
}

export function createSummarizer(deps: SummarizerDeps): Summarizer {
  const timeoutMs = deps.timeoutMs ?? SUMMARIZER_TIMEOUT_MS_DEFAULT;
  return async (prompt: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(
          new Error(
            `Compaction summarizer timed out after ${timeoutMs}ms (single call, no retry)`,
          ),
        );
      });
    });
    try {
      // Single call — no retry wrapper, by contract. Promise.race
      // attaches handlers to both participants, so the losing
      // promise's eventual rejection is observed (no unhandled
      // rejection) while the first settlement wins.
      return await Promise.race([
        deps.request(
          {
            model: deps.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            think: false,
          },
          controller.signal,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
