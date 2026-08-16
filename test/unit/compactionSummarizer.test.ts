import { strict as assert } from 'node:assert';
import {
  SUMMARIZER_TIMEOUT_MS_DEFAULT,
  createSummarizer,
} from '../../src/compactionSummarizer.js';

/**
 * v0.13.0 Slice 2 — summarizer wrapper unit tests (spec:
 * docs/compaction-spec.md § Slice 2 tests).
 *
 * The transport is a fake recording its calls (the production
 * transport is OllamaClient.nativeChatOnce, injected by the provider
 * — covered by the provider-compaction integration tests). These
 * tests pin the CONTRACT: single call, correct body shape, hard
 * timeout, no retry.
 */

interface RecordedRequest {
  body: unknown;
  signal: AbortSignal;
}

function recordingRequest(
  impl: (body: unknown, signal: AbortSignal) => Promise<string>,
): {
  request: (body: unknown, signal: AbortSignal) => Promise<string>;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  return {
    calls,
    request: (body, signal) => {
      calls.push({ body, signal });
      return impl(body, signal);
    },
  };
}

describe('createSummarizer (v0.13.0 slice 2)', () => {
  it('returns the request result and sends the contract body shape', async () => {
    const { request, calls } = recordingRequest(async () => 'CHECKPOINT');
    const summarizer = createSummarizer({ request, model: 'gpt-oss:20b' });

    const result = await summarizer('summarize this');
    assert.equal(result, 'CHECKPOINT');
    assert.equal(calls.length, 1, 'exactly one request per call');

    const body = calls[0]!.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      think: boolean;
    };
    assert.equal(body.model, 'gpt-oss:20b');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]!.role, 'user');
    assert.equal(body.messages[0]!.content, 'summarize this');
    assert.equal(body.stream, false, 'non-streaming call');
    assert.equal(body.think, false, 'thinking disabled');
  });

  it('times out and throws when the request never resolves (tiny timeoutMs)', async () => {
    const { request, calls } = recordingRequest(
      () => new Promise<string>(() => undefined), // never settles
    );
    const summarizer = createSummarizer({
      request,
      model: 'gpt-oss:20b',
      timeoutMs: 25,
    });

    await assert.rejects(() => summarizer('prompt'), /timed out after 25ms/);
    assert.equal(calls.length, 1, 'timeout does not trigger a retry');
  });

  it('forwards the abort signal so the transport can cancel in-flight work', async () => {
    let observed: AbortSignal | undefined;
    const { request } = recordingRequest(
      (_body, signal) =>
        new Promise<string>((_resolve, reject) => {
          observed = signal;
          signal.addEventListener('abort', () =>
            reject(new Error('transport aborted')),
          );
        }),
    );
    const summarizer = createSummarizer({
      request,
      model: 'gpt-oss:20b',
      timeoutMs: 25,
    });

    await assert.rejects(() => summarizer('prompt'), /timed out after 25ms/);
    assert.ok(observed, 'transport received the signal');
    assert.equal(observed!.aborted, true, 'signal is aborted at timeout');
  });

  it('NEVER retries — a failing request is called exactly once', async () => {
    const { request, calls } = recordingRequest(async () => {
      throw new Error('model overloaded');
    });
    const summarizer = createSummarizer({ request, model: 'gpt-oss:20b' });

    await assert.rejects(() => summarizer('prompt'), /model overloaded/);
    assert.equal(calls.length, 1, 'failure is NOT retried');
  });

  it('defaults the timeout to 60s', () => {
    assert.equal(SUMMARIZER_TIMEOUT_MS_DEFAULT, 60_000);
  });
});
