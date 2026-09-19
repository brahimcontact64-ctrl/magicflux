/**
 * Incident 9.9.17E -- the ONE canonical, validated source of the public
 * application origin used to build externally-visible URLs (acknowledgment
 * links today; the same unsafe `NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'`
 * fallback also exists, unfixed, in several payment/billing routes -- see
 * that incident's report for the full list).
 *
 * Root cause this exists to fix: NEXT_PUBLIC_SITE_URL was set on Vercel but
 * never on the Railway worker, so a real Sigma Plus Hot lead's acknowledgment
 * URL silently fell back to http://localhost:3000/... in production email.
 * A silent fallback here is worse than a loud failure -- a broken link a
 * real customer clicks is a support incident with no error anywhere to find.
 *
 * No 'server-only'/server-only-guard marker needed here: this reads only an
 * already-public NEXT_PUBLIC_-prefixed value (Next.js inlines these into the
 * client bundle by convention) and has zero other imports, so it carries no
 * risk of repeating Incident 9.9.17C's worker module-resolution crash.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

// Private/internal ranges a customer's browser could never actually reach --
// never a legitimate value for a link mailed to an external lead.
const PRIVATE_HOSTNAME_PATTERNS: RegExp[] = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local$/i,
  /^internal\./i,
];

function isLocalOrPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(h) || PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(h));
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolves the validated public application origin (no trailing slash).
 *
 * In production: NEXT_PUBLIC_SITE_URL must be set, must parse as a URL, must
 * be https://, and must not resolve to a localhost/private/internal host --
 * any violation throws rather than returning a fallback. A production
 * misconfiguration must surface as a failed execution/request, never as a
 * customer-visible localhost link.
 *
 * Outside production (dev/test/preview without NEXT_PUBLIC_SITE_URL set):
 * falls back to http://localhost:3000, matching this project's existing
 * local-dev convention -- intentionally permissive where it is genuinely
 * safe to be.
 */
export function getPublicOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const prod = isProduction();

  if (!raw) {
    if (prod) {
      throw new Error(
        'NEXT_PUBLIC_SITE_URL is not configured in production -- refusing to generate a customer-visible URL without a validated public origin.'
      );
    }
    return 'http://localhost:3000';
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    if (prod) {
      throw new Error(`NEXT_PUBLIC_SITE_URL ("${raw}") is not a valid URL -- refusing to generate a production-facing link from it.`);
    }
    return 'http://localhost:3000';
  }

  if (prod) {
    if (parsed.protocol !== 'https:') {
      throw new Error(`NEXT_PUBLIC_SITE_URL ("${raw}") must use https:// in production.`);
    }
    if (isLocalOrPrivateHostname(parsed.hostname)) {
      throw new Error(
        `NEXT_PUBLIC_SITE_URL ("${raw}") resolves to a localhost/private host -- refusing to generate a customer-visible production link a real user could never reach.`
      );
    }
  }

  return raw.replace(/\/+$/, '');
}
