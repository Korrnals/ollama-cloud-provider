import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import {
  httpRequest,
  getProxyUrl,
  nodeReadableToWebReadable,
} from '../../src/httpClient.js';
import { logger } from '../../src/logger.js';

/**
 * Integration tests for the proxy-aware HTTP client.
 *
 * Strategy:
 *   - Local HTTP test server via `http.createServer` exercises the
 *     native `node:http` transport end-to-end (status, headers, body
 *     stream, text()).
 *   - AbortSignal test: a server that never responds + an aborted
 *     signal → rejection with `name === 'AbortError'`.
 *   - Error handling: connection refused on an unused port →
 *     rejection.
 *   - Proxy setting: monkey-patches `vscode.workspace.getConfiguration`
 *     so `getProxyUrl()` reads a configured proxy and returns it; the
 *     `'off'` and unset cases return `null`.
 *   - HTTPS-direct path: monkey-patches `https.request` to avoid
 *     needing a real TLS endpoint; verifies the returned `HttpResponse`
 *     shape (`.ok`, `.status`, `.headers.get`, `.body` readable, `.text()`).
 *
 * No production `global.fetch` stub is installed in these tests — the
 * whole point is to exercise the NATIVE node:https/node:http path. The
 * `__isStub` delegation branch in `httpRequest` is therefore skipped.
 */

/**
 * Wraps `vscode.workspace.getConfiguration` so reads of the `http.proxy`
 * key return `value`. Restores the original on `restoreHttpProxyConfig`.
 * The original is captured in a module-level slot so successive
 * `setHttpProxyConfig` calls do not nest wrappers.
 */
let originalGetConfig: typeof vscode.workspace.getConfiguration | null = null;

function setHttpProxyConfig(value: string | undefined): void {
  if (originalGetConfig === null) {
    originalGetConfig = vscode.workspace.getConfiguration;
  }
  const orig = originalGetConfig;
  vscode.workspace.getConfiguration = ((section?: string) => {
    if (section === 'http') {
      const cfg = orig.call(vscode.workspace, 'http');
      // Inject the proxy value via a tiny override that returns our
      // test value for the `proxy` key, and delegates everything else
      // to the real stub config.
      const fakeGet = (key: string, def?: unknown): unknown => {
        if (key === 'proxy') {
          return value;
        }
        return cfg.get(key, def);
      };
      return { ...cfg, get: fakeGet } as typeof cfg;
    }
    return orig.call(vscode.workspace, section);
  }) as typeof vscode.workspace.getConfiguration;
}

function restoreHttpProxyConfig(): void {
  if (originalGetConfig !== null) {
    vscode.workspace.getConfiguration = originalGetConfig;
    originalGetConfig = null;
  }
}

describe('httpClient — proxy-aware native HTTP client', () => {
  let server: http.Server;
  let baseUrl: string;
  let savedDelegate: string | undefined;

  before(async () => {
    // These tests exercise the NATIVE node:https/node:http transport,
    // so disable the test-delegation env var that the mocha loader
    // sets. Restored in `after` so other suites keep delegating to
    // their `global.fetch` stubs.
    savedDelegate = process.env.OLLAMA_HTTP_TEST_DELEGATE;
    delete process.env.OLLAMA_HTTP_TEST_DELEGATE;

    server = http.createServer((req, res) => {
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Test': 'yes' });
        res.end('hello-client');
        return;
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('chunk1\n');
        res.write('chunk2\n');
        res.end();
        return;
      }
      if (req.url === '/stream-hang') {
        // One chunk, then the stream stays open forever — the client
        // must abort mid-stream (task v0210-d2 regression pin).
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('chunk1\n');
        return;
      }
      if (req.url === '/slow') {
        // Never respond — for the abort test.
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedDelegate !== undefined) {
      process.env.OLLAMA_HTTP_TEST_DELEGATE = savedDelegate;
    } else {
      delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    }
  });

  it('direct HTTP request returns correct status + body + headers', async () => {
    const res = await httpRequest(`${baseUrl}/echo`);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-test'), 'yes');
    const text = await res.text();
    assert.equal(text, 'hello-client');
  });

  it('body stream is readable via reader.read()', async () => {
    const res = await httpRequest(`${baseUrl}/stream`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        acc += decoder.decode(value, { stream: true });
      }
    }
    acc += decoder.decode();
    assert.equal(acc, 'chunk1\nchunk2\n');
  });

  it('non-ok status surfaces on res.ok === false', async () => {
    const res = await httpRequest(`${baseUrl}/nope`);
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  });

  it('AbortSignal aborts the request (rejects with AbortError)', async () => {
    const controller = new AbortController();
    const promise = httpRequest(`${baseUrl}/slow`, {
      signal: controller.signal,
    });
    // Abort after a short delay to let the request wire up.
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      promise,
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
  });

  it('mid-stream abort surfaces the TAGGED AbortError on the body reader (v0210-d2)', async () => {
    // Regression pin for the classification race (task v0210-d2,
    // RCA 2026-10-02): a cancellation destroys the socket; the teardown
    // must surface on the BODY stream as the tagged AbortError, never
    // as Node's internal untagged socket-close (code ECONNRESET,
    // message "aborted") that escapes the AbortError routing in
    // streamReader and gets reclassified to ConnectionInterruptedError
    // while the caller merely cancelled. Verified empirically on Node
    // v22: without destroying the response with the tagged error the
    // reader rejects with { code: 'ECONNRESET', message: 'aborted' }.
    const controller = new AbortController();
    const res = await httpRequest(`${baseUrl}/stream-hang`, {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.ok(!first.done && first.value, 'the first chunk must arrive before the abort');

    controller.abort();

    await assert.rejects(
      reader.read(),
      (err: unknown) => {
        assert.ok(
          err instanceof Error && err.name === 'AbortError',
          `body reader must reject with the TAGGED AbortError, got ${
            (err as Error)?.constructor?.name
          } name=${(err as Error)?.name} code=${String((err as { code?: unknown })?.code)} message=${(err as Error)?.message}`,
        );
        return true;
      },
    );
  });

  it('connection refused rejects', async () => {
    // Port 1 is reserved and refuses connections on Linux.
    await assert.rejects(
      httpRequest('http://127.0.0.1:1/echo'),
      (err: unknown) => err instanceof Error,
    );
  });
});

describe('httpClient — proxy setting', () => {
  afterEach(() => restoreHttpProxyConfig());

  it('returns null when http.proxy is unset', () => {
    setHttpProxyConfig(undefined);
    assert.equal(getProxyUrl(), null);
  });

  it('returns null when http.proxy is "off"', () => {
    setHttpProxyConfig('off');
    assert.equal(getProxyUrl(), null);
  });

  it('returns the proxy URL when http.proxy is set', () => {
    setHttpProxyConfig('http://proxy.example.com:8080');
    assert.equal(getProxyUrl(), 'http://proxy.example.com:8080');
  });
});

describe('httpClient — nodeReadableToWebReadable', () => {
  it('converts a Node Readable into a Web ReadableStream of Uint8Array', async () => {
    const nodeStream = new Readable({
      read() {
        this.push(Buffer.from('abc'));
        this.push(Buffer.from('def'));
        this.push(null);
      },
    });
    const web = nodeReadableToWebReadable(nodeStream);
    const reader = web.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    assert.equal(chunks.length, 2);
    assert.deepEqual(Array.from(chunks[0]!), [97, 98, 99]);
    assert.deepEqual(Array.from(chunks[1]!), [100, 101, 102]);
  });
});

/**
 * Security audit P3 + review rework (task v0220-s) — TLS-CONNECT tunnel.
 *
 * `requestViaTlsConnectTunnel` runs TWO wired lifecycles: the CONNECT
 * request and the TLS request issued over the tunnelled socket. The
 * CONNECT marker used to be discarded (spurious WARN on mid-stream
 * abort), and the response-callback form never fired at all (Node
 * delivers CONNECT responses only via the 'connect' event).
 *
 * Rework hardening (all pinned here):
 *   - P1: the TLS leg MUST ride the tunnelled socket. Topology: the
 *     HTTPS target listens ONLY on 127.0.0.2 while the request URL
 *     says `localhost` (= 127.0.0.1) — a direct connection (the
 *     defect: `agent: false` silently ignores createConnection)
 *     cannot reach the target. The proxy counts bytes piped
 *     client→upstream after CONNECT; the tests assert the tunnel
 *     actually carries traffic.
 *   - P3-2: the proxy ENFORCES Proxy-Authorization (credentials from
 *     the userinfo of the configured proxy URL) on CONNECT — without
 *     it the proxy answers 407.
 *   - P3-1: the non-200 branch marks the CONNECT lifecycle BEFORE
 *     rejecting, so the 407 path surfaces no spurious WARN.
 *   - P3-3: the OLLAMA_HTTP_TEST_TLS_INSECURE seam requires the
 *     loader-set DELEGATE var to be present as well; here DELEGATE is
 *     '0' (native transport) — defined, not '1'. NODE_EXTRA_CA_CERTS
 *     cannot replace the seam (Node reads it during bootstrap).
 */
describe('httpClient — TLS-CONNECT tunnel via HTTP proxy (audit P3 + rework)', () => {
  const PROXY_USER = 'ocp-test';
  const PROXY_PASS = 'proxy-pass';
  const EXPECTED_PROXY_AUTH = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')}`;

  let proxy: http.Server;
  let proxyUrl: string;
  let plainProxy: http.Server;
  let plainProxyUrl: string;
  let target: https.Server;
  let targetPort: number;
  let savedDelegate: string | undefined;
  let savedTlsInsecure: string | undefined;
  // Per-test tunnel observability: bytes piped client→upstream after
  // CONNECT 200 (P1 regression pin) and the CONNECT request count.
  const tunnelState = { bytesToUpstream: 0, connectCount: 0 };

  before(async () => {
    // Native node:http/node:https transport with the delegation var
    // DEFINED but off ('0'): delegation must be off for the request to
    // reach the native path, while its presence is one of the two sims
    // the hardened TLS test seam requires (rework P3-3 — a stray
    // TLS_INSECURE var alone can never disable certificate
    // verification in production, where DELEGATE is never set).
    savedDelegate = process.env.OLLAMA_HTTP_TEST_DELEGATE;
    process.env.OLLAMA_HTTP_TEST_DELEGATE = '0';
    savedTlsInsecure = process.env.OLLAMA_HTTP_TEST_TLS_INSECURE;
    process.env.OLLAMA_HTTP_TEST_TLS_INSECURE = '1';

    target = https.createServer(
      {
        key: fs.readFileSync(path.resolve('test/fixtures/tls-test-key.pem')),
        cert: fs.readFileSync(path.resolve('test/fixtures/tls-test-cert.pem')),
      },
      (req, res) => {
        if (req.url === '/tunnel-echo') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('tunnel-ok');
          return;
        }
        if (req.url === '/tunnel-hang') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('chunk1\n');
          return; // stays open — the client aborts mid-stream
        }
        res.writeHead(404);
        res.end('not found');
      },
    );
    // ONLY via 127.0.0.2: the direct path (localhost = 127.0.0.1)
    // cannot reach this server — any wiring that bypasses the proxy
    // fails loudly.
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.2', resolve));
    targetPort = (target.address() as AddressInfo).port;

    proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      tunnelState.connectCount += 1;
      const auth = req.headers['proxy-authorization'];
      const authHeader = Array.isArray(auth) ? auth.join(',') : auth;
      if (authHeader !== EXPECTED_PROXY_AUTH) {
        // P3-2 enforcement: no/incorrect proxy credentials → 407.
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      // Rewrite to the true target address (the URL says localhost,
      // the server lives on 127.0.0.2 — only the proxy can reach it).
      const [host, portStr] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(portStr), host === 'localhost' ? '127.0.0.2' : host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          tunnelState.bytesToUpstream += head.length;
          upstream.write(head);
        }
        // P1 byte counter: everything the client sends through the
        // tunnel after establishment (TLS ClientHello, records).
        clientSocket.on('data', (chunk: Buffer) => {
          tunnelState.bytesToUpstream += chunk.length;
        });
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const kill = (): void => {
        clientSocket.destroy();
        upstream.destroy();
      };
      upstream.on('error', kill);
      clientSocket.on('error', kill);
      clientSocket.on('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    // Plain-HTTP proxy path (P3-2): requires Proxy-Authorization on the
    // absolute-URI request. No forwarding needed — the pin is that the
    // client sends the header.
    plainProxy = http.createServer((req, res) => {
      const auth = req.headers['proxy-authorization'];
      const authHeader = Array.isArray(auth) ? auth.join(',') : auth;
      if (authHeader !== EXPECTED_PROXY_AUTH) {
        res.writeHead(407);
        res.end('proxy auth required');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('plain-proxy-ok');
    });
    await new Promise<void>((resolve) => plainProxy.listen(0, '127.0.0.1', resolve));
    plainProxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${(plainProxy.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    tunnelState.bytesToUpstream = 0;
    tunnelState.connectCount = 0;
  });

  after(() => {
    // Restore process-global state SYNCHRONOUSLY first — never gate
    // the env restore behind an awaited server close (a lingering
    // tunnel socket would stall the hook and leak the env var into
    // every later suite in this mocha process).
    if (savedDelegate !== undefined) {
      process.env.OLLAMA_HTTP_TEST_DELEGATE = savedDelegate;
    } else {
      delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    }
    if (savedTlsInsecure !== undefined) {
      process.env.OLLAMA_HTTP_TEST_TLS_INSECURE = savedTlsInsecure;
    } else {
      delete process.env.OLLAMA_HTTP_TEST_TLS_INSECURE;
    }
    proxy.closeAllConnections?.();
    void proxy.close();
    target.closeAllConnections?.();
    void target.close();
    plainProxy.closeAllConnections?.();
    void plainProxy.close();
  });

  afterEach(() => {
    restoreHttpProxyConfig();
  });

  it('request rides the tunnel end-to-end: proxy-carried bytes > 0, target unreachable directly', async function () {
    this.timeout(4000);
    setHttpProxyConfig(proxyUrl);

    const res = await httpRequest(`https://localhost:${targetPort}/tunnel-echo`);
    assert.equal(res.status, 200, 'the tunnelled HTTPS request must resolve');
    assert.equal(await res.text(), 'tunnel-ok');
    // P1 regression pin: the TLS leg went THROUGH the proxy. The
    // direct-bypass wiring fails here twice — the request cannot reach
    // the 127.0.0.2-only target, and the counter stays at 0.
    assert.ok(
      tunnelState.bytesToUpstream > 0,
      `the tunnel must carry traffic (client→upstream bytes after CONNECT), got ${tunnelState.bytesToUpstream}`,
    );
    assert.equal(tunnelState.connectCount, 1, 'exactly one CONNECT');
  });

  it('mid-stream abort on the REAL tunnel topology: tagged AbortError, ZERO WARNs, proxy traffic goes quiet', async function () {
    this.timeout(4000);
    setHttpProxyConfig(proxyUrl);

    const before = logger.getRecentErrors().length;
    const controller = new AbortController();
    const res = await httpRequest(`https://localhost:${targetPort}/tunnel-hang`, {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.ok(!first.done && first.value, 'first chunk must arrive through the tunnel');
    const bytesAtAbort = tunnelState.bytesToUpstream;
    assert.ok(bytesAtAbort > 0, 'traffic flowed through the proxy before the abort');

    controller.abort();

    // D-2 pin through the tunnel: the body reader rejects with the
    // TAGGED AbortError (never an untagged socket-close).
    await assert.rejects(
      reader.read(),
      (err: unknown) => {
        assert.ok(
          err instanceof Error && err.name === 'AbortError',
          `tunnel body reader must reject with the tagged AbortError, got ${
            (err as Error)?.constructor?.name
          } name=${(err as Error)?.name} code=${String((err as { code?: unknown })?.code)}`,
        );
        return true;
      },
    );

    // The proxy stops seeing traffic: the tunnel was torn down.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      tunnelState.bytesToUpstream,
      bytesAtAbort,
      'no further client→upstream bytes after the abort',
    );

    // The audit P3 pin: after the abort settles, NO
    // "request to localhost failed" WARN — the TLS leg is
    // post-response (teardown artifact, debug only) and the CONNECT
    // leg was marked established by the fix.
    const recent = logger.getRecentErrors().slice(before).join('\n');
    const warnCount = recent.split('request to localhost failed').length - 1;
    assert.equal(
      warnCount,
      0,
      `no WARN may fire for an established tunnel abort; recent errors:\n${recent}`,
    );
  });

  it('CONNECT without proxy credentials → 407 rejection naming the status, no spurious WARN (P3-2 + P3-1)', async function () {
    this.timeout(4000);
    // Same proxy, credentials stripped from the URL.
    setHttpProxyConfig(proxyUrl.replace(`${PROXY_USER}:${PROXY_PASS}@`, ''));

    const before = logger.getRecentErrors().length;
    await assert.rejects(
      httpRequest(`https://localhost:${targetPort}/tunnel-echo`),
      (err: unknown) => {
        assert.match(
          (err as Error).message,
          /CONNECT failed with 407/,
          'the rejection must name the proxy status',
        );
        return true;
      },
    );
    assert.equal(tunnelState.connectCount, 1, 'the CONNECT was attempted once');
    // P3-1: the lifecycle was marked BEFORE the rejection — the
    // teardown racing the 407 must not produce a WARN.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recent = logger.getRecentErrors().slice(before).join('\n');
    const warnCount = recent.split('request to localhost failed').length - 1;
    assert.equal(warnCount, 0, `no WARN on the 407 rejection path; recent:\n${recent}`);
  });

  it('plain-HTTP proxy path sends Proxy-Authorization from the proxy URL userinfo (P3-2)', async function () {
    this.timeout(4000);
    setHttpProxyConfig(plainProxyUrl);

    const res = await httpRequest(`http://localhost:${(plainProxy.address() as AddressInfo).port}/some-path`);
    assert.equal(res.status, 200, 'the auth-enforcing plain proxy must accept the request');
    assert.equal(await res.text(), 'plain-proxy-ok');
  });
});
