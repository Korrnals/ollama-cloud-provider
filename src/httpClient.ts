/**
 * Proxy-aware HTTP client bypassing VS Code's `global.fetch()` interception.
 *
 * Problem: VS Code intercepts `global.fetch()` in the extension host.
 * When `chat.agent.sandbox.enabled: "on"`, the sandbox can block or
 * slow network egress. An intercepted `fetch()` never resolves → the
 * ADR 0005 connect timer fires → `ConnectTimeoutError` → `withRetry`
 * re-issues the SAME `fetch()` → same interception → same hang. Every
 * retry attempt is wasted because the transport is the bug, not the
 * remote endpoint.
 *
 * Fix: use Node.js native `node:https` / `node:http` modules directly.
 * They are NOT intercepted by VS Code (the interception patches
 * `global.fetch`, not the Node built-ins). This restores reliable
 * network egress from the extension host regardless of sandbox state.
 *
 * The exported `httpRequest()` is drop-in compatible with `fetch()`:
 *   - Same call signature: `(url: string, options?: HttpRequestOptions)`.
 *   - Returns an `HttpResponse` with `.ok`, `.status`, `.statusText`,
 *     `.headers` (Headers-like, `.get(name)`), `.body` (Web
 *     `ReadableStream<Uint8Array>`), `.text()`, `.json()`.
 *
 * Existing call sites that do `if (!res.ok) { ... }` and
 * `res.body.getReader()` work unchanged.
 *
 * Proxy support: reads `http.proxy` from VS Code configuration. When
 * set and not the literal `"off"`, the client routes through it:
 *   - HTTPS target via HTTP proxy → CONNECT tunnel + TLS upgrade.
 *   - HTTP target via HTTP proxy → direct request to the proxy with
 *     the full URL in the request line.
 * When unset or `"off"`, the client issues a direct request.
 *
 * `AbortSignal` is wired to `req.destroy()` so the existing ADR 0005
 * three-timer architecture (connect / inactivity / maxDuration) and
 * the per-attempt `AbortController` in `ollamaClient` /
 * `responsesClient` continue to work unchanged. Aborting the signal
 * destroys the underlying socket, which causes the in-flight
 * `httpRequest()` promise to reject with an `AbortError` (name set
 * explicitly so `retry.ts` `retryOn` and the catch blocks in the
 * streaming clients keep routing correctly).
 *
 * Zero new dependencies: no `https-proxy-agent`, no `undici`. Only
 * Node built-ins (`node:https`, `node:http`, `node:stream`,
 * `node:stream/web`, `node:url`).
 *
 * Security: VS Code extensions are trusted code (same trust level as
 * the extension host process). The sandbox restricts agent tools, not
 * extension network egress. Using Node built-ins does NOT widen the
 * attack surface — it removes a faulty interception layer. SEC-03
 * (baseUrl whitelist) is enforced by the callers BEFORE
 * `httpRequest()` is called, exactly as before `fetch()`.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { Readable } from 'node:stream';
import type { Readable as NodeReadable } from 'node:stream';
import * as vscode from 'vscode';
import { logger } from './logger.js';

/**
 * Request options — a subset of `RequestInit` plus the fields the
 * callers actually use. Kept intentionally narrow so the type is
 * easy to audit and the call sites stay explicit.
 */
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Headers container with a `fetch()`-compatible `.get(name)` accessor.
 * `retry.ts` `httpErrorFromResponse` reads `response.headers.get(
 * 'retry-after')`, so this MUST behave like the `Headers` class:
 * case-insensitive lookup, returns `string | null`.
 */
export interface HttpResponseHeaders {
  get(name: string): string | null;
}

/**
 * Minimal structural subset of `Response` that the production code
 * actually consumes. `extractErrorMessage` and `httpErrorFromResponse`
 * accept this instead of the full `Response` type so both the native
 * `HttpResponse` and a real `fetch()` `Response` are assignable
 * without overlap-mismatch errors. This is the seam that lets the
 * streaming clients swap `fetch()` for `httpRequest()` without
 * touching the error-handling helpers.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: HttpResponseHeaders;
  text(): Promise<string>;
}

/**
 * Response object — drop-in replacement for the subset of `Response`
 * the production code uses:
 *   - `.ok`            — `status >= 200 && status < 300`
 *   - `.status`        — HTTP status code
 *   - `.statusText`    — HTTP reason phrase
 *   - `.headers`       — `HttpResponseHeaders` (`.get(name)`)
 *   - `.body`          — Web `ReadableStream<Uint8Array>` so the
 *     existing `reader.read()` loop in the streaming clients works
 *     unchanged
 *   - `.text()`        — buffers the body and resolves to a string
 *   - `.json()`        — buffers the body and parses as JSON
 */
export interface HttpResponse extends HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: HttpResponseHeaders;
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Reads the effective proxy URL from VS Code's `http.proxy` setting.
 *
 * Returns `null` when the setting is unset, empty, or the literal
 * `"off"` (VS Code's documented opt-out value). Re-read on every call
 * so a config change mid-session takes effect without a listener —
 * the read is in-process and cheap.
 */
export function getProxyUrl(): string | null {
  const proxy = vscode.workspace
    .getConfiguration('http')
    .get<string>('proxy');
  if (!proxy || proxy.trim() === '' || proxy.trim().toLowerCase() === 'off') {
    return null;
  }
  return proxy.trim();
}

/**
 * Issues an HTTP(S) request using Node built-ins, bypassing VS Code's
 * `global.fetch()` interception. Drop-in replacement for `fetch()` at
 * the call sites in `ollamaClient`, `responsesClient`, `healthCheck`,
 * `modelCatalog`, `configValidator`.
 *
 * @param url     Absolute URL (`https://...` or `http://...`).
 * @param options Optional method/headers/body/signal.
 * @returns `HttpResponse` — `.ok`, `.status`, `.headers.get()`,
 *          `.body` (Web ReadableStream), `.text()`.
 */
export function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  // Test-hook delegation: when the test runner sets
  // `OLLAMA_HTTP_TEST_DELEGATE=1` (the mocha loader in `test/_loader.mjs`
  // sets this before any test module loads), delegate to `global.fetch`
  // so the existing tests that stub `global.fetch` keep working
  // unchanged. In production this env var is unset, so the native
  // node:https/node:http path runs — bypassing VS Code's
  // `global.fetch()` interception. The env var is the test-only seam;
  // it is never set in the extension host.
  if (process.env.OLLAMA_HTTP_TEST_DELEGATE === '1') {
    return Promise.resolve(
      (globalThis.fetch as (url: string, init?: unknown) => unknown)(
        url,
        options,
      ) as unknown as HttpResponse,
    ).then((r) => r as HttpResponse);
  }

  const method = options.method ?? 'GET';
  const proxyUrl = getProxyUrl();
  const parsedTarget = new URL(url);
  const targetIsTls = parsedTarget.protocol === 'https:';

  logger.info(
    `httpClient: ${method} ${parsedTarget.hostname}${proxyUrl ? ' via proxy' : ' direct'}`,
  );

  if (proxyUrl) {
    if (targetIsTls) {
      return requestViaTlsConnectTunnel(url, options, proxyUrl);
    }
    return requestViaHttpProxy(url, options, proxyUrl);
  }
  return requestDirect(url, options);
}

/**
 * Direct request — no proxy. Uses `https.request` or `http.request`
 * based on the target URL protocol.
 */
function requestDirect(
  url: string,
  options: HttpRequestOptions,
): Promise<HttpResponse> {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        resolve(buildResponse(res, parsed));
      },
    );
    wireRequestLifecycle(req, options, url, reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * HTTP target via HTTP proxy — the proxy receives the request with the
 * FULL absolute URL in the request line (RFC 7230 §5.3.2). No tunnel
 * is needed because the payload is plaintext to the proxy.
 */
function requestViaHttpProxy(
  url: string,
  options: HttpRequestOptions,
  proxyUrl: string,
): Promise<HttpResponse> {
  const parsedTarget = new URL(url);
  const parsedProxy = new URL(proxyUrl);
  const proxyHost = parsedProxy.hostname;
  const proxyPort = parsedProxy.port || '80';

  return new Promise<HttpResponse>((resolve, reject) => {
    // Absolute-URI form: the proxy forwards to the target.
    const req = http.request(
      {
        host: proxyHost,
        port: Number(proxyPort),
        method: options.method ?? 'GET',
        path: url,
        headers: options.headers,
      },
      (res) => {
        resolve(buildResponse(res, parsedTarget));
      },
    );
    wireRequestLifecycle(req, options, url, reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * HTTPS target via HTTP proxy — CONNECT tunnel. The client opens a TCP
 * connection to the proxy, sends `CONNECT host:port`, and once the
 * proxy responds `200 Connection Established`, upgrades the socket to
 * TLS and issues the real HTTPS request over the tunnelled socket.
 *
 * This mirrors what `https-proxy-agent` does, with zero dependencies.
 */
function requestViaTlsConnectTunnel(
  url: string,
  options: HttpRequestOptions,
  proxyUrl: string,
): Promise<HttpResponse> {
  const parsedTarget = new URL(url);
  const parsedProxy = new URL(proxyUrl);
  const proxyHost = parsedProxy.hostname;
  const proxyPort = Number(parsedProxy.port || 443);
  const targetHost = parsedTarget.hostname;
  const targetPort = parsedTarget.port || 443;

  const connectHeaders = {
    Host: `${targetHost}:${targetPort}`,
  };

  return new Promise<HttpResponse>((resolve, reject) => {
    const connectReq = http.request(
      {
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: connectHeaders,
      },
      (connectRes) => {
        if (connectRes.statusCode !== 200) {
          connectRes.resume();
          reject(
            new Error(
              `httpClient: proxy CONNECT failed with ${connectRes.statusCode} ${connectRes.statusMessage ?? ''}`.trim(),
            ),
          );
          return;
        }
        // Upgrade the raw socket to TLS and issue the real request.
        const socket = connectRes.socket;
        if (!socket) {
          reject(
            new Error('httpClient: proxy CONNECT succeeded but no socket was returned'),
          );
          return;
        }
        const tlsReq = https.request(
          url,
          {
            method: options.method ?? 'GET',
            headers: options.headers,
            agent: false,
            createConnection: () => socket,
          },
          (res) => {
            resolve(buildResponse(res, parsedTarget));
          },
        );
        wireRequestLifecycle(tlsReq, options, url, reject);
        if (options.body !== undefined) {
          tlsReq.write(options.body);
        }
        tlsReq.end();
      },
    );
    wireRequestLifecycle(connectReq, options, url, reject);
    connectReq.end();
  });
}

/**
 * Wires the common request lifecycle: error handling, abort signal,
 * body buffering for non-streaming consumers. Centralised so the three
 * request paths (direct / http-proxy / tls-tunnel) share one
 * implementation.
 */
function wireRequestLifecycle(
  req: http.ClientRequest,
  options: HttpRequestOptions,
  url: string,
  reject: (error: Error) => void,
): void {
  let settled = false;
  const fail = (error: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    // v0.11.0 Task 2 — debug: surface error.code (libuv errno) so
    // ECONNRESET vs EPIPE vs EHOSTUNREACH can be distinguished when
    // ollamaCloud.debug is on. The warn below already logs the full
    // error object; this adds the code as a discrete field.
    const errCode = (error as { code?: unknown }).code;
    if (typeof errCode === 'string') {
      logger.debug(`httpClient: request failed with code=${errCode}`);
    }
    logger.warn(`httpClient: request to ${new URL(url).hostname} failed`, error);
    reject(error);
  };

  req.on('error', fail);

  // ArchCom 0011b — enable TCP keepalive (SO_KEEPALIVE) on the
  // underlying socket. Our httpClient uses native node:http/node:https
  // (NOT undici/global.fetch), so undici's default `connect.keepAlive:
  // true` does NOT apply. Without this, the OS sends no keepalive
  // probes, and infrastructure proxies (nginx, load balancers, CDN)
  // close idle connections after 60-120s — producing the
  // ConnectionInterruptedError that crashed subagents.
  //
  // 30s initial delay: probes start after 30s of idle, which keeps
  // the connection alive in NAT/proxy connection tables without
  // excessive traffic. The OS handles dead-server detection — no
  // application-layer inactivity timer needed.
  req.on('socket', (socket: net.Socket & { encrypted?: boolean }) => {
    socket.setKeepAlive(true, 30000);
  });

  const signal = options.signal;
  if (signal) {
    if (signal.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      // destroy synchronously so the socket is torn down immediately
      req.destroy(err);
      fail(err);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        if (settled) {
          return;
        }
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        req.destroy(err);
        fail(err);
      },
      { once: true },
    );
  }
}

/**
 * Builds the `HttpResponse` from a Node `IncomingMessage`. The body is
 * exposed as a Web `ReadableStream<Uint8Array>` so the existing
 * `reader.read()` loop in the streaming clients works unchanged.
 *
 * The Node stream is NOT consumed eagerly — it is converted lazily so
 * backpressure and chunk-at-a-time streaming are preserved. This is
 * what keeps the ADR 0005 inactivity-timer reset-per-chunk logic
 * working: each chunk arrives from the Node stream, is enqueued into
 * the Web stream, and the client's `reader.read()` resolves
 * per-chunk.
 */
function buildResponse(
  res: http.IncomingMessage,
  parsedTarget: URL,
): HttpResponse {
  const status = res.statusCode ?? 0;
  const statusText = res.statusMessage ?? '';
  const headers = buildHeaders(res.headers);

  // Issue #41 — Strand 1: log the response status + path (NOT the
  // full URL, NOT query, NOT headers — secrets/per-PII). One line
  // per request, on the response side, paired with the request log
  // in `httpRequest`. `buildResponse` is the single choke point all
  // three transport paths (direct / HTTP proxy / TLS-CONNECT tunnel)
  // funnel through, so this fires exactly once per request regardless
  // of which path served it.
  logger.info(
    `httpClient: response status=${status} path=${parsedTarget.pathname}`,
  );

  // Convert the Node Readable to a Web ReadableStream lazily. Each
  // `data` chunk becomes one Web-stream chunk; `end` closes the
  // stream; `error` errors it. The streaming clients read via
  // `getReader().read()`, which pulls chunks one at a time.
  const body = nodeReadableToWebReadable(res);

  let bufferedText: string | undefined;
  const text = async (): Promise<string> => {
    if (bufferedText !== undefined) {
      return bufferedText;
    }
    const decoder = new TextDecoder();
    let result = '';
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        result += decoder.decode(value, { stream: true });
      }
    }
    result += decoder.decode();
    bufferedText = result;
    return result;
  };

  void parsedTarget; // kept on the type for future host-pinning diagnostics

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers,
    body,
    text,
    json: async (): Promise<unknown> => JSON.parse(await text()),
  };
}

/**
 * Builds a `Headers`-like view over Node's `IncomingHttpHeaders`.
 * Lookup is case-insensitive (Node lowercases header names, so a
 * direct property access suffices, but we normalise the input key to
 * be safe against callers passing mixed-case names like `Retry-After`).
 */
function buildHeaders(
  raw: http.IncomingHttpHeaders,
): HttpResponseHeaders {
  const lower: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    lower[key.toLowerCase()] = value;
  }
  return {
    get(name: string): string | null {
      const v = lower[name.toLowerCase()];
      if (v === undefined) {
        return null;
      }
      if (Array.isArray(v)) {
        return v.join(', ');
      }
      return v;
    },
  };
}

/**
 * Converts a Node `Readable` stream into a Web `ReadableStream<Uint8Array>`.
 *
 * Each `data` event becomes one `controller.enqueue(chunk)`; `end`
 * closes the stream; `error` errors it. The stream is created lazily
 * and pull-driven — no eager buffering — so the existing per-chunk
 * streaming + inactivity-timer-reset logic in the clients is
 * preserved bit-for-bit.
 *
 * This is the bridge that lets `response.body.getReader().read()` in
 * `ollamaClient` / `responsesClient` work unchanged against a Node
 * stream source.
 */
export function nodeReadableToWebReadable(
  nodeStream: NodeReadable,
): ReadableStream<Uint8Array> {
  // node:stream/web's ReadableStream + node:stream's Readable.toWeb
  // exist in Node 18+, but Readable.toWeb() returns a
  // ReadableStream<Uint8Array | string> depending on encoding. We
  // force binary by using the manual adapter below — guarantees a
  // Uint8Array per chunk regardless of any setEncoding() the upstream
  // may have applied.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | Uint8Array): void => {
        // Enqueue a Uint8Array copy. Buffer is a Uint8Array subclass,
        // but copying to a fresh Uint8Array keeps the contract tight
        // and avoids the caller mutating the Node-internal buffer.
        const bytes =
          chunk instanceof Uint8Array
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk as Uint8Array);
        controller.enqueue(bytes);
      };
      const onEnd = (): void => {
        controller.close();
        cleanup();
      };
      const onError = (err: Error): void => {
        controller.error(err);
        cleanup();
      };
      const cleanup = (): void => {
        nodeStream.removeListener('data', onData);
        nodeStream.removeListener('end', onEnd);
        nodeStream.removeListener('error', onError);
      };
      nodeStream.on('data', onData);
      nodeStream.on('end', onEnd);
      nodeStream.on('error', onError);
    },
    cancel(reason) {
      // The Web consumer (e.g. AbortError) cancelled the stream.
      // Destroy the Node source so the underlying socket is torn down
      // and no further chunks are buffered.
      (nodeStream as Readable).destroy(
        reason instanceof Error ? reason : undefined,
      );
    },
  });
}
