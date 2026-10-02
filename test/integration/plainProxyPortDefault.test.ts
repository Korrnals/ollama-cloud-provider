import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { httpRequest } from '../../src/httpClient.js';

/**
 * TL rider (v0221-p2-composition-tests, reviewer fast-follow P3-2 from
 * the security-hygiene verdict) — the PLAIN-proxy path's port default
 * is not directly pinned: the Sec F2 fix (proxyPortOrDefault, commit
 * d6070ff) landed with CONNECT-sink tests for the tunnel path, but the
 * existing plainProxy tests all use EXPLICIT ports, so a regression of
 * `requestViaHttpProxy` back to the scheme-blind `|| '80'` hardcode (a
 * port-less `https://` proxy silently connecting — and shipping its
 * `Proxy-Authorization` — to whatever listens on :80) would go
 * unnoticed.
 *
 * Topology mirrors the F2 three-sink listener-identity suite in
 * httpClient.test.ts: plain HTTP sinks on 127.0.0.1:80 and
 * 127.0.0.1:443 record the request line each received. WHICH sink saw
 * the request is exactly the port-default under test. An HTTP target
 * through an HTTP proxy is sent in absolute-URI form to the proxy
 * (RFC 7230 §5.3.2) — no CONNECT, no TLS leg, no upstream dial, no
 * DNS: the sink answers directly.
 *
 * Binding :80/:443 unprivileged works on this host
 * (net.ipv4.ip_unprivileged_port_start=80); if either port is occupied
 * the `listen` fails and this suite says so explicitly instead of
 * passing vacuously. Because the F2 suite binds the same ports earlier
 * in the mocha process, `listenWithReleaseRetry` retries EADDRINUSE
 * briefly (kernel port release after `close()` is asynchronous).
 */
describe('httpClient — plain-proxy path port default (Sec F2 fast-follow P3-2, rider)', () => {
  const sightings80: string[] = [];
  const sightings443: string[] = [];
  let sink80: http.Server;
  let sink443: http.Server;
  let savedDelegate: string | undefined;
  let originalGetConfig: typeof vscode.workspace.getConfiguration | null = null;

  /** Minimal plain-proxy sink: record the request line (absolute URI), answer 200. */
  const makeSink = (sightings: string[], body: string): http.Server => {
    const server = http.createServer((req, res) => {
      sightings.push(req.url ?? '');
      res.end(body);
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

  /** `listen` with a bounded EADDRINUSE retry (async kernel port release). */
  const listenWithReleaseRetry = async (
    server: http.Server,
    port: number,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await listen(server, port);
        return;
      } catch (error) {
        if (
          attempt < 60 &&
          (error as { code?: string }).code === 'EADDRINUSE'
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        throw error;
      }
    }
  };

  /** Same http.proxy injection pattern as httpClient.test.ts. */
  const setHttpProxy = (value: string | undefined): void => {
    if (originalGetConfig === null) {
      originalGetConfig = vscode.workspace.getConfiguration;
    }
    const orig = originalGetConfig;
    vscode.workspace.getConfiguration = ((section?: string) => {
      if (section === 'http') {
        const cfg = orig.call(vscode.workspace, 'http');
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
  };

  const restoreHttpProxy = (): void => {
    if (originalGetConfig !== null) {
      vscode.workspace.getConfiguration = originalGetConfig;
      originalGetConfig = null;
    }
  };

  before(async function () {
    // The bind-retry window (up to ~6 s under suite load) must not hit
    // the config's 5 s default HOOK timeout.
    this.timeout(20000);
    // Native transport, same pattern as the F2 suite — never leak the
    // env into later suites (restored synchronously in after()).
    savedDelegate = process.env.OLLAMA_HTTP_TEST_DELEGATE;
    delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    sink80 = makeSink(sightings80, 'plain-80-ok');
    sink443 = makeSink(sightings443, 'plain-443-ok');
    await listenWithReleaseRetry(sink80, 80);
    await listenWithReleaseRetry(sink443, 443);
  });

  after(() => {
    if (savedDelegate !== undefined) {
      process.env.OLLAMA_HTTP_TEST_DELEGATE = savedDelegate;
    } else {
      delete process.env.OLLAMA_HTTP_TEST_DELEGATE;
    }
    restoreHttpProxy();
    sink80.closeAllConnections?.();
    void sink80.close();
    sink443.closeAllConnections?.();
    void sink443.close();
  });

  afterEach(() => {
    restoreHttpProxy();
    sightings80.length = 0;
    sightings443.length = 0;
  });

  it('http target + port-less https:// proxy: the absolute-URI request lands on :443, never :80', async function () {
    // Generous margin: the bind-retry window in before() can consume
    // several seconds under suite load before this it() even starts.
    this.timeout(10000);
    // Port-less https:// PROXY URL — the proxy scheme selects the
    // default port (443); the target is plain HTTP, so the transport is
    // requestViaHttpProxy (absolute-URI request, no CONNECT tunnel).
    setHttpProxy('https://127.0.0.1');

    const res = await httpRequest('http://plain-target.example/y');
    assert.equal(
      await res.text(),
      'plain-443-ok',
      'the :443 sink answered (the request resolved through it)',
    );
    // The absolute-URI form reached the :443 listener — the rider's
    // positive assertion.
    assert.deepEqual(
      sightings443,
      ['http://plain-target.example/y'],
      'the :443 sink saw the absolute-URI request line',
    );
    // The pre-F2 plain-path default (scheme-blind 80) fails here: the
    // request — headers included — would have been delivered to
    // whatever listens on :80.
    assert.equal(
      sightings80.length,
      0,
      ':80 must NOT see the request (port-less https:// proxy defaults to 443)',
    );
  });
});
