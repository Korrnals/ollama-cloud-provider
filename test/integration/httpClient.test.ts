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
    // QUIESCENCE, not byte-exact equality (issue #51): the abort can
    // land while TLS records are still buffered in the client socket,
    // so a deterministic remainder may flush into the tunnel AFTER
    // bytesAtAbort was sampled — `bytesToUpstream === bytesAtAbort` at
    // a fixed 150 ms grace was a record-timing lottery (4933 !== 1759
    // on pipeline-shaped runs). What the pin MEANS: traffic DID flow
    // before the abort (asserted above), and after the abort the
    // counter eventually freezes. Poll until two samples QUIET_WINDOW_MS
    // apart show no growth, bounded by QUIET_CAP_MS; the first window
    // absorbs any in-flight flush, stability proves teardown. The
    // poll also guarantees >= QUIET_WINDOW_MS of settle time before
    // the WARN check below.
    const QUIET_WINDOW_MS = 150;
    const QUIET_CAP_MS = 1500;
    const quietDeadline = Date.now() + QUIET_CAP_MS;
    let prevSample = tunnelState.bytesToUpstream;
    let quiet = false;
    while (Date.now() < quietDeadline) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
      const sample = tunnelState.bytesToUpstream;
      if (sample === prevSample) {
        quiet = true;
        break;
      }
      prevSample = sample;
    }
    assert.ok(
      quiet,
      `client→upstream traffic must go quiet within ${QUIET_CAP_MS} ms of the abort `
        + `(counter ${bytesAtAbort} at the abort, last sample ${prevSample})`,
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

/**
 * Sec F2 (task v0221-p3) — the proxy port must default by the PROXY
 * URL's own protocol (`http://` → 80, `https://` → 443), never by the
 * target's scheme. The CONNECT path used to hardcode 443, so a
 * port-less `http://` proxy sent its CONNECT — with
 * `Proxy-Authorization` — to whatever happens to listen on :443
 * instead of the proxy's own :80 listener.
 *
 * Topology: three minimal CONNECT sinks — 127.0.0.1:80,
 * 127.0.0.1:443, and an ephemeral port. Each records the CONNECT
 * targets it received and answers 403 (the client then rejects fast
 * with `CONNECT failed with 403`; no TLS leg, no upstream connection,
 * no DNS — the sink never dials out). WHICH sink saw the request is
 * exactly the port-default under test.
 *
 * Binding :80/:443 unprivileged works on this host
 * (net.ipv4.ip_unprivileged_port_start=80); if either port is
 * occupied the `listen` fails and this suite says so explicitly
 * instead of passing vacuously.
 */
describe('httpClient — proxy port defaults by PROXY URL protocol (Sec F2, v0221-p3)', () => {
  const sightings80: string[] = [];
  const sightings443: string[] = [];
  const sightingsEphemeral: string[] = [];
  let sink80: http.Server;
  let sink443: http.Server;
  let sinkEphemeral: http.Server;
  let ephemeralPort: number;
  let savedDelegate: string | undefined;

  /** Minimal CONNECT sink: record the connect target, answer 403. */
  const makeSink = (sightings: string[]): http.Server => {
    const server = http.createServer();
    server.on('connect', (req, clientSocket) => {
      sightings.push(req.url ?? '');
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    return server;
  };

  const listen = (server: http.Server, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

  before(async () => {
    // Native transport, same pattern as the suites above.
    savedDelegate = process.env.OLLAMA_HTTP_TEST_DELEGATE;
    delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    sink80 = makeSink(sightings80);
    sink443 = makeSink(sightings443);
    sinkEphemeral = makeSink(sightingsEphemeral);
    await listen(sink80, 80);
    await listen(sink443, 443);
    await listen(sinkEphemeral, 0);
    ephemeralPort = (sinkEphemeral.address() as AddressInfo).port;
  });

  after(() => {
    // Restore process-global state SYNCHRONOUSLY first (same rule as
    // the tunnel suite — never leak env into later suites).
    if (savedDelegate !== undefined) {
      process.env.OLLAMA_HTTP_TEST_DELEGATE = savedDelegate;
    } else {
      delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    }
    sink80.closeAllConnections?.();
    void sink80.close();
    sink443.closeAllConnections?.();
    void sink443.close();
    sinkEphemeral.closeAllConnections?.();
    void sinkEphemeral.close();
  });

  afterEach(() => {
    restoreHttpProxyConfig();
    sightings80.length = 0;
    sightings443.length = 0;
    sightingsEphemeral.length = 0;
  });

  it('port-less http:// proxy: the CONNECT lands on the proxy :80 listener, never :443', async function () {
    this.timeout(4000);
    setHttpProxyConfig('http://127.0.0.1');

    await assert.rejects(
      httpRequest('https://connect-target.example:443/x'),
      (err: unknown) => {
        assert.match(
          (err as Error).message,
          /CONNECT failed with 403/,
          'the sink 403 must surface as the CONNECT failure',
        );
        return true;
      },
    );
    // The connect target assertion: the :80 sink saw exactly this
    // CONNECT, and the :443 sink saw nothing (the old hardcoded-443
    // default fails the second half).
    assert.deepEqual(
      sightings80,
      ['connect-target.example:443'],
      'the CONNECT target must arrive at the :80 listener',
    );
    assert.equal(sightings443.length, 0, ':443 must NOT receive the CONNECT');
    assert.equal(sightingsEphemeral.length, 0);
  });

  it('port-less https:// proxy: the CONNECT lands on :443', async function () {
    this.timeout(4000);
    setHttpProxyConfig('https://127.0.0.1');

    await assert.rejects(
      httpRequest('https://connect-target.example:443/x'),
      /CONNECT failed with 403/,
    );
    assert.deepEqual(
      sightings443,
      ['connect-target.example:443'],
      'the CONNECT target must arrive at the :443 listener',
    );
    assert.equal(sightings80.length, 0, ':80 must not be touched');
    assert.equal(sightingsEphemeral.length, 0);
  });

  it('explicit proxy port is honored over either default', async function () {
    this.timeout(4000);
    setHttpProxyConfig(`http://127.0.0.1:${ephemeralPort}`);

    await assert.rejects(
      httpRequest('https://connect-target.example:443/x'),
      /CONNECT failed with 403/,
    );
    assert.deepEqual(
      sightingsEphemeral,
      ['connect-target.example:443'],
      'the CONNECT must arrive at the explicitly configured port',
    );
    assert.equal(
      sightings80.length + sightings443.length,
      0,
      'neither default port may be touched when a port is explicit',
    );
  });
});

/**
 * Sec F4 (task v0221-p3) — the insecure test transport
 * (`rejectUnauthorized: false`) used to activate SILENTLY when dev
 * leftovers (`OLLAMA_HTTP_TEST_TLS_INSECURE=1` + any
 * `OLLAMA_HTTP_TEST_DELEGATE`) sat in a user's shell env. Activation
 * must now WARN, naming both env vars so the operator knows what to
 * unset.
 *
 * v0.22.1: the WARN fires once per activation streak (module-level
 * guard in httpClient), not once per CONNECT attempt — pinned below.
 *
 * Topology: a minimal CONNECT proxy that answers 200 and immediately
 * destroys the socket — the TLS leg fails fast. The WARN fires before
 * `tls.connect`, so the assertion does not depend on the TLS outcome.
 */
describe('httpClient — insecure test transport activation warns (Sec F4, v0221-p3)', () => {
  let proxy: http.Server;
  let proxyPort: number;
  let savedDelegate: string | undefined;
  let savedTlsInsecure: string | undefined;

  /** The request under test: through the sink proxy, TLS target. */
  const requestThroughSinkProxy = (): Promise<unknown> => {
    setHttpProxyConfig(`http://127.0.0.1:${proxyPort}`);
    return httpRequest('https://insecure-warn.example:443/x');
  };

  before(async () => {
    savedDelegate = process.env.OLLAMA_HTTP_TEST_DELEGATE;
    savedTlsInsecure = process.env.OLLAMA_HTTP_TEST_TLS_INSECURE;
    proxy = http.createServer();
    proxy.on('connect', (_req, clientSocket) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  beforeEach(() => {
    // P2-1 (QA final cascade, v0.22.1): count from a CLEAN ring. The
    // warn/error ring is capped at 100 entries (RECENT_ERRORS_CAP,
    // push → shift); when it wraps between the baseline capture and
    // the post-read, the slice(before) deltas below silently drop the
    // lines under test. QA's literal `getRecentErrors().splice(0)` was
    // a no-op — that accessor returns a defensive copy — so the ring
    // is cleared through the explicit `clearRecentErrors()` seam.
    logger.clearRecentErrors();
  });

  after(() => {
    // Synchronous env restore first — same rule as the tunnel suite.
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
  });

  afterEach(() => {
    restoreHttpProxyConfig();
  });

  it('activation with both test env vars logs a WARN naming both', async function () {
    this.timeout(4000);
    // Re-arm the once-per-activation WARN first: the tunnel suite
    // earlier in this mocha process exercises the seam with the
    // insecure transport ACTIVE, consuming the activation WARN. A
    // CONNECT with the opt-in unset observes verification restored and
    // re-arms the guard, making the activation transition below
    // deterministic (Sec F4 dedup, v0.22.1).
    process.env.OLLAMA_HTTP_TEST_DELEGATE = '0';
    delete process.env.OLLAMA_HTTP_TEST_TLS_INSECURE;
    await assert.rejects(
      requestThroughSinkProxy(),
      (err: unknown) => err instanceof Error,
    );

    process.env.OLLAMA_HTTP_TEST_TLS_INSECURE = '1';

    const before = logger.getRecentErrors().length;
    await assert.rejects(
      requestThroughSinkProxy(),
      (err: unknown) => err instanceof Error,
    );
    const recent = logger.getRecentErrors().slice(before).join('\n');
    assert.ok(
      recent.includes('OLLAMA_HTTP_TEST_TLS_INSECURE') &&
        recent.includes('OLLAMA_HTTP_TEST_DELEGATE'),
      `the activation WARN must name BOTH env vars so the user knows what to unset; recent:\n${recent}`,
    );
    assert.ok(
      recent.includes('[WARN]'),
      'the line must be a WARN (visible in the default output channel), ' +
        `recent:\n${recent}`,
    );
    // Sec F4 dedup pin (v0.22.1): a second request in the SAME
    // activation streak must not add a second insecure-transport WARN
    // line — the module-level guard makes the warning
    // once-per-activation, not once-per-CONNECT.
    const beforeSecond = logger.getRecentErrors().length;
    await assert.rejects(
      requestThroughSinkProxy(),
      (err: unknown) => err instanceof Error,
    );
    const secondDelta = logger.getRecentErrors()
      .slice(beforeSecond)
      .join('\n');
    assert.ok(
      !secondDelta.includes('insecure TEST transport'),
      `a second CONNECT in the same activation must NOT re-warn (once-per-activation guard); recent:\n${secondDelta}`,
    );
  });

  it('without the insecure opt-in, no insecure-transport WARN fires', async function () {
    this.timeout(4000);
    process.env.OLLAMA_HTTP_TEST_DELEGATE = '0';
    delete process.env.OLLAMA_HTTP_TEST_TLS_INSECURE;

    const before = logger.getRecentErrors().length;
    await assert.rejects(
      requestThroughSinkProxy(),
      (err: unknown) => err instanceof Error,
    );
    const recent = logger.getRecentErrors().slice(before).join('\n');
    assert.ok(
      !recent.includes('insecure TEST transport'),
      `no insecure-transport WARN without the opt-in (the request itself may WARN about the torn-down tunnel — that is fine); recent:\n${recent}`,
    );
  });
});
