/**
 * SSRF guard — defence-in-depth DNS-resolution layer (v0.12.0, ADR 0012).
 * IPv4-embedded IPv6 classification + local private-range handling added
 * in the v0.12.0 pre-release review. Uses dependency injection for the
 * DNS resolver (NOT sinon stubs).
 */
import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

export type DnsResolver = (hostname: string) => Promise<LookupAddress | LookupAddress[]>;

export interface SsrfGuardOptions {
  readonly allowLoopback?: boolean;
  /**
   * v0.12.0 review P1 fix — permit RFC 1918 ranges (10/8, 172.16/12,
   * 192.168/16) for user-configured LOCAL connections (LAN-hosted
   * Ollama, e.g. http://192.168.1.50:11434). Link-local 169.254/16
   * (cloud metadata), CGNAT 100.64/10, 0/8 and ALL IPv6-sensitive
   * ranges stay blocked regardless — cloud metadata never lives in
   * RFC 1918, so those never relax.
   */
  readonly allowPrivateRanges?: boolean;
  /** Optional user-facing advice appended to SsrfBlockedError messages. */
  readonly advice?: string;
}

/**
 * Strips C0 controls (0x00–0x1F) and DEL (0x7F) from hostnames and URL
 * fragments before they are embedded in error messages — control chars
 * in log lines are a log-forging vector (v0.12.0 review P2 fix).
 */
function sanitizeForMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

export class SsrfBlockedError extends Error {
  readonly hostname: string;
  readonly blockedIp: string;
  readonly blockedRange: string;
  constructor(hostname: string, blockedIp: string, blockedRange: string, advice?: string) {
    const safeHostname = sanitizeForMessage(hostname);
    super(
      `Ollama Cloud: SSRF guard blocked '${safeHostname}' — resolved to ${blockedIp} (${blockedRange}). ` +
        (advice ?? 'Use a public hostname.'),
    );
    this.name = 'SsrfBlockedError';
    this.hostname = safeHostname;
    this.blockedIp = blockedIp;
    this.blockedRange = blockedRange;
  }
}

type ParsedIp =
  | { family: 4; octets: [number, number, number, number]; raw: string }
  | { family: 6; groups: number[]; raw: string };

function parseIpv4(input: string): ParsedIp | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const octets: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    if (!/^\d+$/.test(parts[i]!)) return null;
    const v = Number(parts[i]);
    if (v < 0 || v > 255) return null;
    octets[i] = v;
  }
  return { family: 4, octets, raw: input };
}

function expandIpv6(input: string): number[] | null {
  const parts = input.split('::');
  if (parts.length > 2) return null;
  const parseGroup = (s: string): number | null => {
    if (s === '') return 0;
    if (!/^[0-9a-f]{1,4}$/i.test(s)) return null;
    return parseInt(s, 16);
  };
  if (parts.length === 1) {
    const groups = input.split(':').map(parseGroup);
    if (groups.length !== 8 || groups.some(g => g === null)) return null;
    return groups as number[];
  }
  const left = parts[0] === '' ? [] : parts[0]!.split(':').map(parseGroup);
  const right = parts[1] === '' ? [] : parts[1]!.split(':').map(parseGroup);
  if (left.some(g => g === null) || right.some(g => g === null)) return null;
  const fill = 8 - (left.length + right.length);
  if (fill < 1) return null;
  return [...(left as number[]), ...new Array(fill).fill(0), ...(right as number[])];
}

function parseIpv6(input: string): ParsedIp | null {
  const stripped = input.replace(/^\[|\]$/g, '');
  if (!stripped.includes(':')) return null;
  try {
    const url = new URL(`http://[${stripped}]/`);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const groups = expandIpv6(hostname);
    if (groups === null) return null;
    return { family: 6, groups, raw: hostname };
  } catch {
    return null;
  }
}

function parseIpLiteral(input: string): ParsedIp | null {
  const ipv4 = parseIpv4(input);
  if (ipv4 !== null) return ipv4;
  return parseIpv6(input);
}

/** Extracts the low 32 bits of an IPv6 address as IPv4 octets. */
function octetsFromLowBits(g: number[]): [number, number, number, number] {
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
}

/**
 * Classifies IPv4 octets — shared by the IPv4 branch and every IPv6 form
 * that embeds an IPv4 address (v0.12.0 review P1 fix). Range names are
 * identical for both paths so error messages stay uniform.
 */
function classifyIpv4Octets(
  octets: [number, number, number, number],
  allowLoopback: boolean,
  allowPrivateRanges: boolean,
): string | null {
  const [a, b] = octets;
  if (a === 0) return '0.0.0.0/8 (unrouted)';
  if (a === 10) return allowPrivateRanges ? null : '10.0.0.0/8 (RFC 1918 private)';
  if (a === 100 && b >= 64 && b <= 127) return '100.64.0.0/10 (CGNAT)';
  if (a === 127) return allowLoopback ? null : '127.0.0.0/8 (loopback)';
  if (a === 169 && b === 254) return '169.254.0.0/16 (link-local / cloud metadata)';
  if (a === 172 && b >= 16 && b <= 31) return allowPrivateRanges ? null : '172.16.0.0/12 (RFC 1918 private)';
  if (a === 192 && b === 168) return allowPrivateRanges ? null : '192.168.0.0/16 (RFC 1918 private)';
  return null;
}

function classifyIp(ip: ParsedIp, allowLoopback: boolean, allowPrivateRanges: boolean): string | null {
  if (ip.family === 4) {
    return classifyIpv4Octets(ip.octets, allowLoopback, allowPrivateRanges);
  }
  const g = ip.groups;
  // Unspecified '::' — never a legitimate destination (review finding 5).
  if (g.every(v => v === 0)) return '::/128 (unspecified)';
  if (g.every((v, i) => v === (i === 7 ? 1 : 0))) {
    return allowLoopback ? null : '::1/128 (loopback)';
  }
  // IPv4-mapped '::ffff:a.b.c.d' — the embedded IPv4 must be classified,
  // otherwise it bypasses every IPv4 range check (v0.12.0 review P1 fix).
  if (g[0]! === 0 && g[1]! === 0 && g[2]! === 0 && g[3]! === 0 && g[4]! === 0 && g[5]! === 0xffff) {
    return classifyIpv4Octets(octetsFromLowBits(g), allowLoopback, allowPrivateRanges);
  }
  // NAT64 '64:ff9b::/96' — embedded IPv4, same treatment.
  if (g[0]! === 0x64 && g[1]! === 0xff9b && g[2]! === 0 && g[3]! === 0 && g[4]! === 0 && g[5]! === 0) {
    return classifyIpv4Octets(octetsFromLowBits(g), allowLoopback, allowPrivateRanges);
  }
  // IPv4-compatible '::a.b.c.d' (legacy, deprecated) — low 32 bits as IPv4.
  if (g[0]! === 0 && g[1]! === 0 && g[2]! === 0 && g[3]! === 0 && g[4]! === 0 && g[5]! === 0) {
    return classifyIpv4Octets(octetsFromLowBits(g), allowLoopback, allowPrivateRanges);
  }
  if (g[0]! >= 0xfe80 && g[0]! <= 0xfebf) return 'fe80::/10 (link-local)';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'fc00::/7 (unique-local / RFC 4193)';
  return null;
}

export class SsrfGuard {
  private readonly resolveDns: DnsResolver;
  private readonly allowLoopback: boolean;
  private readonly allowPrivateRanges: boolean;
  private readonly advice: string | undefined;

  constructor(resolveDns: DnsResolver, options?: SsrfGuardOptions) {
    this.resolveDns = resolveDns;
    this.allowLoopback = options?.allowLoopback ?? false;
    this.allowPrivateRanges = options?.allowPrivateRanges ?? false;
    this.advice = options?.advice;
  }

  async assertUrlAllowed(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`SSRF guard: malformed URL '${sanitizeForMessage(url.slice(0, 60))}'.`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const literal = parseIpLiteral(hostname);
    if (literal !== null) {
      const blocked = classifyIp(literal, this.allowLoopback, this.allowPrivateRanges);
      if (blocked !== null) throw new SsrfBlockedError(hostname, literal.raw, blocked, this.advice);
      return;
    }
    let resolved: LookupAddress | LookupAddress[];
    try {
      resolved = await this.resolveDns(hostname);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SSRF guard: DNS resolution failed for '${sanitizeForMessage(hostname)}': ${msg}`);
    }
    const addresses = Array.isArray(resolved) ? resolved : [resolved];
    for (const addr of addresses) {
      const parsed = parseIpLiteral(addr.address);
      if (parsed === null) continue;
      const blocked = classifyIp(parsed, this.allowLoopback, this.allowPrivateRanges);
      if (blocked !== null) throw new SsrfBlockedError(hostname, parsed.raw, blocked, this.advice);
    }
  }
}

/**
 * Production factory — real `dns.lookup` resolver (`{ all: true }`,
 * dual-stack; every resolved address is checked, which catches DNS
 * rebinding). Options:
 *
 * - `allowLoopback` — permit 127/8 and ::1 (LOCAL connections only).
 * - `allowPrivateRanges` — permit RFC 1918 ranges for user-configured
 *   LOCAL connections (LAN-hosted Ollama). Cloud metadata (169.254/16),
 *   CGNAT, 0/8 and all IPv6-sensitive ranges never relax.
 * - `advice` — appended to `SsrfBlockedError` messages; the cloud guard
 *   points users at the `ollamaCloud.allowedBaseUrls` whitelist (no
 *   override mechanism exists by design).
 */
export function createProductionSsrfGuard(options?: SsrfGuardOptions): SsrfGuard {
  const resolveDns: DnsResolver = (hostname: string) =>
    dns.lookup(hostname, { all: true });
  return new SsrfGuard(resolveDns, options);
}
