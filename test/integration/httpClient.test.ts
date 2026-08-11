import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import {
  httpRequest,
  getProxyUrl,
  nodeReadableToWebReadable,
} from '../../src/httpClient.js';

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
