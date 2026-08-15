import assert from 'node:assert';
import { strict as assertStrict } from 'node:assert';
import {
  SsrfGuard,
  SsrfBlockedError,
  createProductionSsrfGuard,
  type DnsResolver,
} from '../../src/ssrfGuard.js';

/**
 * v0.12.0 ADR 0012 — SSRF guard unit tests.
 *
 * The guard uses dependency injection: tests inject a fake `DnsResolver`
 * that returns a controlled IP without touching the network. This is the
 * pattern explicitly required by the v0.12.0 task acceptance criteria
 * ("use dependency injection for the DNS resolver, not sinon stubs").
 *
 * Coverage matrix:
 *   - Cloud-metadata IPv4 (169.254.169.254) → blocked
 *   - RFC 1918 private (10.x, 172.16-31.x, 192.168.x) → blocked
 *   - Loopback (127.0.0.1, ::1) → blocked unless allowLoopback
 *   - Link-local IPv6 (fe80::) → blocked
 *   - Unique-local IPv6 (fc00::/7, fd00:ec2::) → blocked
 *   - CGNAT (100.64.0.0/10) → blocked
 *   - 0.0.0.0/8 → blocked
 *   - Public IPv4 (1.2.3.4) → allowed
 *   - Public IPv6 (2606:4700::) → allowed
 *   - Literal IP in URL (no DNS) → classified directly
 *   - DNS resolution failure → surfaced as plain Error (not blocked)
 *   - Dual-stack hostname (public + private) → blocked (rebinding)
 *   - Malformed URL → surfaced as plain Error
 */

/** Builds a fake resolver that returns the given IPs for any hostname. */
function fakeResolver(...ips: string[]): DnsResolver {
  return async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

/** Builds a fake resolver that throws, simulating DNS failure. */
function throwingResolver(error: Error): DnsResolver {
  return async () => {
    throw error;
  };
}

describe('SsrfGuard (v0.12.0 ADR 0012)', () => {
  describe('blocks cloud-metadata addresses', () => {
    it('blocks 169.254.169.254 (AWS/GCP/Azure metadata)', async () => {
      const guard = new SsrfGuard(fakeResolver('169.254.169.254'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://evil.example.com/api'),
        SsrfBlockedError,
        /169\.254\.0\.0\/16/,
      );
    });
  });

  describe('blocks RFC 1918 private ranges', () => {
    it('blocks 10.0.0.1', async () => {
      const guard = new SsrfGuard(fakeResolver('10.0.0.1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://internal.example.com/api'),
        SsrfBlockedError,
        /10\.0\.0\.0\/8/,
      );
    });

    it('blocks 172.16.0.1 (start of 172.16/12)', async () => {
      const guard = new SsrfGuard(fakeResolver('172.16.0.1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://internal.example.com/api'),
        SsrfBlockedError,
        /172\.16\.0\.0\/12/,
      );
    });

    it('blocks 172.31.255.255 (end of 172.16/12)', async () => {
      const guard = new SsrfGuard(fakeResolver('172.31.255.255'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://internal.example.com/api'),
        SsrfBlockedError,
        /172\.16\.0\.0\/12/,
      );
    });

    it('allows 172.32.0.1 (outside 172.16/12)', async () => {
      const guard = new SsrfGuard(fakeResolver('172.32.0.1'));
      await guard.assertUrlAllowed('https://edge.example.com/api');
      // No throw = pass
    });

    it('blocks 192.168.1.1', async () => {
      const guard = new SsrfGuard(fakeResolver('192.168.1.1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://router.example.com/api'),
        SsrfBlockedError,
        /192\.168\.0\.0\/16/,
      );
    });
  });

  describe('blocks loopback only when allowLoopback is false', () => {
    it('blocks 127.0.0.1 by default', async () => {
      const guard = new SsrfGuard(fakeResolver('127.0.0.1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://localhost.example.com/api'),
        SsrfBlockedError,
        /127\.0\.0\.0\/8/,
      );
    });

    it('allows 127.0.0.1 when allowLoopback: true (local Ollama)', async () => {
      const guard = new SsrfGuard(fakeResolver('127.0.0.1'), { allowLoopback: true });
      await guard.assertUrlAllowed('http://localhost:11434/api/chat');
      // No throw = pass
    });

    it('blocks ::1 by default', async () => {
      const guard = new SsrfGuard(fakeResolver('::1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://localhost.example.com/api'),
        SsrfBlockedError,
        /::1\/128/,
      );
    });

    it('allows ::1 when allowLoopback: true', async () => {
      const guard = new SsrfGuard(fakeResolver('::1'), { allowLoopback: true });
      await guard.assertUrlAllowed('http://[::1]:11434/api/chat');
      // No throw = pass
    });
  });

  describe('blocks IPv6 sensitive ranges', () => {
    it('blocks fe80::1 (link-local)', async () => {
      const guard = new SsrfGuard(fakeResolver('fe80::1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://evil.example.com/api'),
        SsrfBlockedError,
        /fe80::\/10/,
      );
    });

    it('blocks fd00:ec2::254 (AWS IMDSv6)', async () => {
      const guard = new SsrfGuard(fakeResolver('fd00:ec2::254'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://evil.example.com/api'),
        SsrfBlockedError,
        /fc00::\/7|fd00:ec2/i,
      );
    });

    it('blocks fc00::1 (unique-local)', async () => {
      const guard = new SsrfGuard(fakeResolver('fc00::1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://evil.example.com/api'),
        SsrfBlockedError,
        /fc00::\/7/,
      );
    });
  });

  describe('blocks CGNAT and unrouted', () => {
    it('blocks 100.64.0.1 (CGNAT)', async () => {
      const guard = new SsrfGuard(fakeResolver('100.64.0.1'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://evil.example.com/api'),
        SsrfBlockedError,
        /100\.64\.0\.0\/10/,
      );
    });

    it('blocks 0.0.0.0 (unrouted)', async () => {
      const guard = new SsrfGuard(fakeResolver('0.0.0.0'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://evil.example.com/api'),
        SsrfBlockedError,
        /0\.0\.0\.0\/8/,
      );
    });
  });

  describe('allows public addresses', () => {
    it('allows public IPv4 (1.2.3.4)', async () => {
      const guard = new SsrfGuard(fakeResolver('1.2.3.4'));
      await guard.assertUrlAllowed('https://api.example.com/api/chat');
    });

    it('allows Cloudflare public IPv6 (2606:4700::)', async () => {
      const guard = new SsrfGuard(fakeResolver('2606:4700::1'));
      await guard.assertUrlAllowed('https://api.example.com/api/chat');
    });

    it('allows ollama.com resolved IP', async () => {
      // Use a documented public IP — do not actually resolve.
      const guard = new SsrfGuard(fakeResolver('104.18.42.79'));
      await guard.assertUrlAllowed('https://ollama.com/api/chat');
    });
  });

  describe('handles literal IP in URL (no DNS)', () => {
    it('blocks a literal cloud-metadata IPv4 URL', async () => {
      // Resolver should NOT be called when URL has a literal IP.
      const guard = new SsrfGuard(throwingResolver(new Error('should not resolve')));
      await assertRejects(
        () => guard.assertUrlAllowed('https://169.254.169.254/latest/meta-data/'),
        SsrfBlockedError,
        /169\.254\.0\.0\/16/,
      );
    });

    it('allows a literal public IPv4 URL', async () => {
      const guard = new SsrfGuard(throwingResolver(new Error('should not resolve')));
      await guard.assertUrlAllowed('https://1.2.3.4/api');
    });

    it('blocks a literal IPv6 loopback URL', async () => {
      const guard = new SsrfGuard(throwingResolver(new Error('should not resolve')));
      await assertRejects(
        () => guard.assertUrlAllowed('https://[::1]/api'),
        SsrfBlockedError,
        /::1\/128/,
      );
    });
  });

  describe('handles DNS resolution failure', () => {
    it('surfaces ENOTFOUND as a plain Error (not SsrfBlockedError)', async () => {
      const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND bad.host'), {
        code: 'ENOTFOUND',
      });
      const guard = new SsrfGuard(throwingResolver(dnsError));
      await assertRejects(
        () => guard.assertUrlAllowed('https://bad.host.nonexistent/api'),
        Error,
        /DNS resolution failed/,
      );
    });
  });

  describe('detects DNS rebinding (dual-stack public+private)', () => {
    it('blocks when one of two resolved IPs is private', async () => {
      // A dual-stack hostname that resolves to both a public and a
      // private IP is the classic DNS-rebinding attack setup.
      const guard = new SsrfGuard(fakeResolver('1.2.3.4', '169.254.169.254'));
      await assertRejects(
        () => guard.assertUrlAllowed('https://rebinding.example.com/api'),
        SsrfBlockedError,
        /169\.254\.0\.0\/16/,
      );
    });
  });

  describe('handles malformed URLs', () => {
    it('surfaces a malformed URL as a plain Error', async () => {
      const guard = new SsrfGuard(fakeResolver('1.2.3.4'));
      await assertRejects(
        () => guard.assertUrlAllowed('not-a-url'),
        Error,
        /malformed URL/,
      );
    });
  });

  describe('production factory', () => {
    it('createProductionSsrfGuard returns a usable guard (loopback allowed)', () => {
      const guard = createProductionSsrfGuard({ allowLoopback: true });
      assertStrict.ok(guard instanceof SsrfGuard);
    });

    it('createProductionSsrfGuard returns a usable guard (loopback denied)', () => {
      const guard = createProductionSsrfGuard({ allowLoopback: false });
      assertStrict.ok(guard instanceof SsrfGuard);
    });
  });
});

/**
 * Asserts that `fn` rejects with an error matching the given type and
 * message regex. Mocha awaits the returned promise.
 */
async function assertRejects(
  fn: () => Promise<unknown>,
  // Structural type — accepts any constructor that returns an Error-like
  // instance, regardless of its parameter signature. Avoids friction with
  // classes like SsrfBlockedError that take multiple constructor args.
  ExpectedError: { new (...args: any[]): Error; name: string },
  messageRegex: RegExp,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    assert(
      error instanceof ExpectedError,
      `expected ${ExpectedError.name}, got ${(error as Error).constructor.name}: ${(error as Error).message}`,
    );
    assert(
      messageRegex.test((error as Error).message),
      `message "${(error as Error).message}" does not match ${messageRegex}`,
    );
  }
  assert(threw, 'expected promise to reject, but it resolved');
}
