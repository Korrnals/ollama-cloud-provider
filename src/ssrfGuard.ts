/**
 * SSRF guard — defence-in-depth DNS-resolution layer (v0.12.0, ADR 0012).
 * Uses dependency injection for the DNS resolver (NOT sinon stubs).
 */
import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

export type DnsResolver = (hostname: string) => Promise<LookupAddress | LookupAddress[]>;

export interface SsrfGuardOptions {
  readonly allowLoopback?: boolean;
}

export class SsrfBlockedError extends Error {
  readonly hostname: string;
  readonly blockedIp: string;
  readonly blockedRange: string;
  constructor(hostname: string, blockedIp: string, blockedRange: string) {
    super(`Ollama Cloud: SSRF guard blocked '${hostname}' — resolved to ${blockedIp} (${blockedRange}). Use a public hostname or add an explicit override.`);
    this.name = 'SsrfBlockedError';
    this.hostname = hostname;
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

function classifyIp(ip: ParsedIp, allowLoopback: boolean): string | null {
  if (ip.family === 4) {
    const [a, b] = ip.octets;
    if (a === 0) return '0.0.0.0/8 (unrouted)';
    if (a === 10) return '10.0.0.0/8 (RFC 1918 private)';
    if (a === 100 && b >= 64 && b <= 127) return '100.64.0.0/10 (CGNAT)';
    if (a === 127) return allowLoopback ? null : '127.0.0.0/8 (loopback)';
    if (a === 169 && b === 254) return '169.254.0.0/16 (link-local / cloud metadata)';
    if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (RFC 1918 private)';
    if (a === 192 && b === 168) return '192.168.0.0/16 (RFC 1918 private)';
    return null;
  }
  const g = ip.groups;
  if (g.every((v, i) => v === (i === 7 ? 1 : 0))) {
    return allowLoopback ? null : '::1/128 (loopback)';
  }
  if (g[0]! >= 0xfe80 && g[0]! <= 0xfebf) return 'fe80::/10 (link-local)';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'fc00::/7 (unique-local / RFC 4193)';
  return null;
}

export class SsrfGuard {
  private readonly resolveDns: DnsResolver;
  private readonly allowLoopback: boolean;

  constructor(resolveDns: DnsResolver, options?: SsrfGuardOptions) {
    this.resolveDns = resolveDns;
    this.allowLoopback = options?.allowLoopback ?? false;
  }

  async assertUrlAllowed(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`SSRF guard: malformed URL '${url.slice(0, 60)}'.`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const literal = parseIpLiteral(hostname);
    if (literal !== null) {
      const blocked = classifyIp(literal, this.allowLoopback);
      if (blocked !== null) throw new SsrfBlockedError(hostname, literal.raw, blocked);
      return;
    }
    let resolved: LookupAddress | LookupAddress[];
    try {
      resolved = await this.resolveDns(hostname);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SSRF guard: DNS resolution failed for '${hostname}': ${msg}`);
    }
    const addresses = Array.isArray(resolved) ? resolved : [resolved];
    for (const addr of addresses) {
      const parsed = parseIpLiteral(addr.address);
      if (parsed === null) continue;
      const blocked = classifyIp(parsed, this.allowLoopback);
      if (blocked !== null) throw new SsrfBlockedError(hostname, parsed.raw, blocked);
    }
  }
}

export function createProductionSsrfGuard(options?: SsrfGuardOptions): SsrfGuard {
  const resolveDns: DnsResolver = (hostname: string) =>
    dns.lookup(hostname, { all: true });
  return new SsrfGuard(resolveDns, options);
}
