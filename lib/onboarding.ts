/**
 * Onboarding gate logic — Phase 9.2.
 *
 * user_profiles.onboarding_complete already exists in production (written
 * by signup, never previously read by anything) — no schema migration was
 * needed for this feature.
 *
 * Compatibility problem this module exists to solve: EVERY currently
 * existing production user_profiles row has onboarding_complete=false
 * (the flag was written but never consumed before this phase). Gating
 * purely on that flag would force every pre-existing account into
 * onboarding on their next login — explicitly forbidden. ONBOARDING_LAUNCH_CUTOFF
 * is the moment this feature shipped; any profile created before it is
 * grandfathered regardless of the flag's value. A second, independent
 * signal (already having any workflow) grandfathers accounts even if the
 * cutoff comparison were ever wrong for some edge case — belt and
 * suspenders, not the primary mechanism.
 */

/** ISO timestamp captured at implementation time (2026-09-01), comfortably
 * after every pre-existing production account and before this feature's
 * first real deploy. */
export const ONBOARDING_LAUNCH_CUTOFF = '2026-09-01T15:46:24.267Z';

export type OnboardingProfile = {
  onboarding_complete: boolean | null;
  created_at: string | null;
} | null;

/**
 * Pure decision function — no I/O, fully unit-testable.
 *
 * @param profile              The user's user_profiles row, or null if none
 *                             exists yet. Every current production account
 *                             already has one (created at signup); a
 *                             missing row is treated as "needs onboarding"
 *                             unless hasExistingWorkflows says otherwise —
 *                             getUserFromRequest() only returns {id, email},
 *                             not auth.users.created_at, so there is no
 *                             second timestamp signal to fall back to here.
 * @param hasExistingWorkflows Whether the user already owns at least one
 *                             workflow — independent grandfather signal.
 */
export function shouldUserOnboard(
  profile: OnboardingProfile,
  hasExistingWorkflows: boolean,
): boolean {
  if (hasExistingWorkflows) return false;

  if (profile) {
    if (profile.onboarding_complete === true) return false;
    const createdAt = profile.created_at;
    if (createdAt && createdAt < ONBOARDING_LAUNCH_CUTOFF) return false; // grandfathered
    return true; // genuinely new profile, flag not yet set
  }

  return true; // no profile row and no existing workflows — treat as new
}
