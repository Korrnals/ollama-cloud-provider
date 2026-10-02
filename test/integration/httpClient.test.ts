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
 * Security audit P3 (task v0220-s) — TLS-CONNECT tunnel lifecycle.
 *
 * `requestViaTlsConnectTunnel` runs TWO wired lifecycles: the CONNECT
 * request and the TLS request issued over the tunnelled socket. The
 * CONNECT marker used to be discarded, so its lifecycle never learned
 * the tunnel was established — a mid-stream abort through an HTTP
 * proxy then logged a spurious "httpClient: request to <host> failed"
 * WARN for an already-succeeded CONNECT.
 *
 * While pinning the audit item a deeper routing defect surfaced: Node
 * delivers a CONNECT response ONLY via the 'connect' event (the old
 * response-callback body — TLS upgrade and non-200 reject — never
 * ran, so the tunnel hung until the caller aborted, producing exactly
 * the audit's WARN). These tests exercise a REAL tunnel end-to-end:
 * a local HTTP proxy answers CONNECT and pipes raw TCP to a local
 * HTTPS target. The target uses the committed self-signed fixture
 * cert; the tunnel's TLS leg trusts it via the
 * OLLAMA_HTTP_TEST_TLS_INSECURE test seam (NODE_EXTRA_CA_CERTS cannot
 * be used — Node reads it during process bootstrap, before any test
 * code runs).
 */
describe('httpClient — TLS-CONNECT tunnel via HTTP proxy (audit P3)', () => {
  let proxy: http.Server;
  let proxyUrl: string;
  let target: https.Server;
  let targetPort: number;
  let savedDelegate: string | undefined;
  let savedTlsInsecure: string | undefined;

  before(async () => {
    // Native node:http/node:https transport — disable the test
    // delegation env var (same as the direct-transport suite above).
    savedDelegate = process.env.OLLAMA_HTTP_TEST_DELEGATE;
    delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    // Trust the self-signed fixture cert for the tunnel's TLS leg
    // (test seam — see src/httpClient.ts).
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
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as AddressInfo).port;

    proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      const [host, portStr] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(portStr), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const kill = (): void => {
        clientSocket.destroy();
        upstream.destroy();
      };
      upstream.on('error', kill);
      clientSocket.on('error', kill);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  after(() => {
    // Restore process-global state SYNCHRONOUSLY first — never gate
    // the env restore behind an awaited server close (a lingering
    // tunnel socket would stall the hook and leak the deleted env var
    // into every later suite in this mocha process).
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
  });

  afterEach(() => {
    restoreHttpProxyConfig();
  });

  it('request through an established tunnel succeeds end-to-end (CONNECT routed via the connect event)', async function () {
    this.timeout(4000); // pre-fix this hung forever — fail fast, not at the suite timeout
    setHttpProxyConfig(proxyUrl);

    const res = await httpRequest(`https://localhost:${targetPort}/tunnel-echo`);
    assert.equal(res.status, 200, 'the tunnelled HTTPS request must resolve');
    assert.equal(await res.text(), 'tunnel-ok');
  });

  it('mid-stream abort through an established tunnel: tagged AbortError on the reader, ZERO "request failed" WARNs', async function () {
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

    // The audit P3 pin: after the abort settles, NO
    // "request to localhost failed" WARN — the TLS leg is
    // post-response (teardown artifact, debug only) and the CONNECT
    // leg was marked established by the fix.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recent = logger.getRecentErrors().slice(before).join('\n');
    const warnCount = recent.split('request to localhost failed').length - 1;
    assert.equal(
      warnCount,
      0,
      `no WARN may fire for an established tunnel abort; recent errors:\n${recent}`,
    );
  });
});
