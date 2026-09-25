/**
 * Workflow #2 Phase D.1 -- the fail-closed production guard. Every Phase D
 * local-staging certification script MUST call one of the exported
 * functions here, with the actual Supabase URL it is about to use, BEFORE
 * doing anything else (before any seed, migration, or send).
 *
 * Deliberately allow-list based, not deny-list based: this does not just
 * check "is this the known production ref" (a deny-list, which only ever
 * protects against the ONE ref it happens to know about) -- it requires the
 * target to match a RECOGNIZED LOCAL host pattern, and separately, always
 * rejects the known production ref explicitly as an extra, redundant
 * check. An unrecognized host (a typo, a different cloud project, a
 * different environment entirely) is refused by default, not guessed at.
 *
 * Reusable by design (per Phase D.1's own explicit requirement) -- nothing
 * here is specific to any one certification script.
 */

export const PRODUCTION_PROJECT_REF = 'obszpocughyndybjvshn';

const ALLOWED_LOCAL_HOSTNAME_PATTERNS: RegExp[] = [
  /^127\.0\.0\.1$/,
  /^localhost$/,
  /^0\.0\.0\.0$/,
  /^host\.docker\.internal$/,
  /^::1$/,
];

export class ProductionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionTargetError';
  }
}

/**
 * Throws ProductionTargetError if `supabaseUrl` is not a recognized local
 * Supabase host, OR if it matches the known production project ref by name
 * (belt-and-suspenders -- this second check is redundant with the
 * allow-list above for any URL shaped like a normal Supabase cloud host,
 * but is kept explicit and separate so it is provably checked even if the
 * allow-list logic is ever refactored).
 */
export function assertLocalSupabaseTarget(supabaseUrl: string | undefined): void {
  if (!supabaseUrl) {
    throw new ProductionTargetError('No Supabase URL was provided at all -- refusing to proceed without an explicit, verified local target.');
  }

  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new ProductionTargetError(`Supabase URL "${supabaseUrl}" is not a valid URL -- refusing to proceed.`);
  }

  if (url.hostname.toLowerCase().includes(PRODUCTION_PROJECT_REF.toLowerCase())) {
    throw new ProductionTargetError(
      `REFUSING TO PROCEED: target URL host "${url.hostname}" matches the known PRODUCTION Supabase project (${PRODUCTION_PROJECT_REF}). This operation is local-staging-only.`
    );
  }

  const isRecognizedLocal = ALLOWED_LOCAL_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname));
  if (!isRecognizedLocal) {
    throw new ProductionTargetError(
      `REFUSING TO PROCEED: target host "${url.hostname}" is not a recognized local Supabase host (expected 127.0.0.1/localhost). This operation is local-staging-only and never guesses at an unfamiliar target.`
    );
  }
}

/**
 * CLI-facing wrapper for standalone scripts: prints a clear, non-secret
 * error and exits non-zero immediately, rather than throwing (which would
 * otherwise surface as an unhandled rejection/stack trace). Never call this
 * from library code or tests -- use assertLocalSupabaseTarget() directly
 * there, so a violation is a catchable/assertable error, not a process
 * exit.
 */
export function assertLocalSupabaseTargetOrExit(supabaseUrl: string | undefined): void {
  try {
    assertLocalSupabaseTarget(supabaseUrl);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
