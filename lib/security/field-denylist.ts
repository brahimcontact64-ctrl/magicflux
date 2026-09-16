/**
 * Shared internal/sensitive field-name denylist.
 *
 * Originally introduced in lib/agent/notification-content-guard.ts (Phase
 * 9.9.9, Part G) to stop a generated notification from referencing
 * execution bookkeeping or a credential-shaped field name. Phase 9.9.10
 * reuses the exact same denylist for the qualification policy's input
 * allowlist (Part H) -- one authoritative list, never two that could drift.
 * Matched against a FIELD NAME only, never a value.
 */

const DENYLISTED_EXACT_FIELDS = new Set(['_conditionbranch', '_conditionresult']);

const DENYLISTED_NAME_PATTERN = /token|secret|credential|password|passwd|api[_-]?key|client[_-]?id|webhook|header|authorization/i;

/** True when `fieldName` is internal execution bookkeeping or looks credential/secret-shaped -- never safe to expose to a notification, a qualification policy, or any other business-facing surface. */
export function isDenylistedFieldName(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  if (DENYLISTED_EXACT_FIELDS.has(lower)) return true;
  return DENYLISTED_NAME_PATTERN.test(fieldName);
}
