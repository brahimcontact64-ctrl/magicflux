/**
 * SSRF protection for the generic HTTP node.
 *
 * The HTTP node lets a user supply an arbitrary URL that the server then
 * fetches with server-side credentials/network access — the classic SSRF
 * surface (attacker-controlled workflow → server-side request to internal
 * infrastructure or cloud metadata endpoints).
 *
 * Policy (overridable — see RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS below):
 *   - Only http:// and https:// schemes are allowed.
 *   - Loopback (127.0.0.0/8, ::1), RFC1918 private ranges, link-local
 *     (169.254.0.0/16 — includes the AWS/GCP/Azure metadata IP
 *     169.254.169.254), IPv6 ULA (fc00::/7) and link-local (fe80::/10),
 *     0.0.0.0/8, and CGNAT (100.64.0.0/10) are blocked.
 *   - Every hostname is resolved and ALL returned addresses are checked
 *     (not just the first) before the request is made.
 *   - Redirects are followed manually (not by fetch's built-in follower) so
 *     each hop is re-validated — a 200 response from an allowed host that
 *     redirects to a metadata endpoint is blocked, not silently followed.
 *
 * Residual risk (documented, not silently ignored): validation happens via a
 * DNS lookup performed by this guard; the actual fetch() call performs its
 * own, separate DNS lookup when connecting. An attacker controlling DNS with
 * a very short TTL could theoretically return a different (blocked) address
 * between the two lookups ("DNS rebinding"). Fully closing that gap requires
 * pinning the validated IP at the socket layer (a custom low-level dispatcher),
 * which is a larger change intentionally deferred — see Phase 7.5 report.
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';

export type SsrfCheckResult = { allowed: true } | { allowed: false; reason: string };

function allowPrivateNetworks(): boolean {
  return process.env.RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS === 'true';
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8',        // "this network"
  '127.0.0.0/8',      // loopback
  '10.0.0.0/8',        // RFC1918
  '172.16.0.0/12',     // RFC1918
  '192.168.0.0/16',    // RFC1918
  '169.254.0.0/16',    // link-local — includes cloud metadata 169.254.169.254
  '100.64.0.0/10',     // CGNAT
  '192.0.0.0/24',      // IETF protocol assignments
  '198.18.0.0/15',     // benchmarking
  '224.0.0.0/4',       // multicast
  '240.0.0.0/4',       // reserved
];

/** Extracts the embedded IPv4 address from an IPv4-mapped IPv6 address (::ffff:a.b.c.d), or null. */
function unwrapIpv4MappedIpv6(ip: string): string | null {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return match ? match[1] : null;
}

export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return BLOCKED_IPV4_RANGES.some((cidr) => ipv4InCidr(ip, cidr));
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true; // loopback
    if (normalized === '::') return true; // unspecified
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true; // link-local fe80::/10
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7
    const mapped = unwrapIpv4MappedIpv6(normalized);
    if (mapped) return isBlockedAddress(mapped);
    return false;
  }
  return true; // not a recognizable IP — fail closed
}

/**
 * Resolves `hostname` and checks every returned address against the
 * blocklist. Returns { allowed: false } if ANY resolved address is blocked,
 * or if resolution fails (fail closed — an unreachable/unresolvable host is
 * not a legitimate request target).
 */
export async function checkHostnameSafe(hostname: string): Promise<SsrfCheckResult> {
  if (allowPrivateNetworks()) return { allowed: true };

  const directIpVersion = net.isIP(hostname);
  if (directIpVersion !== 0) {
    if (isBlockedAddress(hostname)) {
      return { allowed: false, reason: `Request target ${hostname} is in a blocked private/internal address range` };
    }
    return { allowed: true };
  }

  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    return { allowed: false, reason: `Could not resolve host: ${hostname}` };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `Host ${hostname} did not resolve to any address` };
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return { allowed: false, reason: `Host ${hostname} resolves to ${address}, which is in a blocked private/internal address range` };
    }
  }

  return { allowed: true };
}

/**
 * Full pre-flight check for a request URL: scheme + resolved-address validation.
 */
export async function checkUrlSafe(rawUrl: string): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Unsupported URL scheme: ${parsed.protocol} (only http/https are allowed)` };
  }

  return checkHostnameSafe(parsed.hostname);
}
