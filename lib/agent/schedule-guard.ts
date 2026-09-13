/**
 * Phase 9.8.8 -- Schedule Contract Truth.
 *
 * Deterministic, fail-closed guards for the `trigger: 'schedule'` generation
 * path. Root cause (production investigation, Founder Schedule -> Gmail
 * attempt): the generation prompt gave the model a raw free-text `schedule`
 * string ("today at 14:45") with zero contract on the required node
 * type/parameter shape and zero timezone context, so it invented an
 * unrecognized node type instead of the canonical n8n-nodes-base.scheduleTrigger.
 * The strengthened prompt (executor.ts) is guidance, not a guarantee -- these
 * functions are the backstop:
 *   1. detectOneTimeSchedulePhrase() stops a one-time/absolute request from
 *      ever reaching generation, rather than letting the model silently
 *      force it into a recurring cron.
 *   2. isValidIanaTimezone() enforces an explicit, real IANA timezone instead
 *      of a silent UTC default.
 *   3. validateCanonicalScheduleTrigger() rejects, post-generation, any
 *      schedule-like node that isn't exactly n8n-nodes-base.scheduleTrigger
 *      with a valid cronExpression and the required timezone.
 *
 * MagicFlux's scheduler (lib/runtime/scheduler.ts's pollDueSchedules()) is
 * fundamentally recurring-cron -- it always recomputes and advances
 * next_run_at after firing, with no "fire once then disable" mechanism.
 * True one-time scheduling would need a real schema/runtime change and is
 * explicitly out of scope for this phase.
 */

import * as cronParser from 'cron-parser';

export const ONE_TIME_SCHEDULE_REJECTION_MESSAGE =
  'One-time scheduled runs are not supported yet. Please use a recurring schedule, such as every 5 minutes, daily at 09:00, or every Monday at 09:00.';

export const MISSING_TIMEZONE_MESSAGE =
  'A specific IANA timezone (e.g. "Africa/Algiers", "America/New_York") is required for a scheduled workflow. It will not be guessed or defaulted to UTC.';

// Recurring cadence words. If any of these are present, the phrase is
// treated as a recurring schedule regardless of any co-occurring one-time
// word (e.g. "every day starting today" is recurring).
const RECURRING_MARKERS = /\bevery\b|\bdaily\b|\bhourly\b|\bweekly\b|\bmonthly\b|\beach\s+(day|hour|week|month|minute)\b/i;

// Absolute/one-off temporal markers: a specific day, date, or relative-day
// reference with no recurring cadence attached.
const ONE_TIME_MARKERS =
  /\btoday\b|\btomorrow\b|\btonight\b|\bthis\s+(morning|afternoon|evening|weekend)\b|\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\bon\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}\b/i;

/** True when `text` describes a single absolute occurrence rather than a recurring cadence. */
export function detectOneTimeSchedulePhrase(text: string): boolean {
  const normalized = (text ?? '').toLowerCase().trim();
  if (!normalized) return false;
  if (RECURRING_MARKERS.test(normalized)) return false;
  return ONE_TIME_MARKERS.test(normalized);
}

/** True only for a string Intl actually resolves as a real IANA timezone. Never guesses/defaults. */
export function isValidIanaTimezone(tz: string): boolean {
  const value = (tz ?? '').trim();
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const CANONICAL_SCHEDULE_TRIGGER_TYPE = 'n8n-nodes-base.scheduletrigger';
// Broad net for "this node was clearly meant to start the workflow on a
// timer" -- catches invented alternates (a legacy n8n-nodes-base.cron type,
// a custom interval/timer node) that would otherwise sail through the
// generic capability filter's substring-based "known type" check.
const SCHEDULE_LIKE_SUBSTRINGS = ['trigger', 'cron', 'interval', 'timer'];

export type ScheduleTriggerValidation =
  | { ok: true }
  | { ok: false; reason: string; invalidTypes: string[] };

/**
 * Deterministic post-generation gate for `trigger: 'schedule'` requests.
 * Requires exactly the canonical n8n-nodes-base.scheduleTrigger type, a
 * valid cronExpression, and a timezone matching `requiredTimezone` exactly
 * (never silently substituted or defaulted).
 */
export function validateCanonicalScheduleTrigger(
  nodes: unknown[],
  requiredTimezone: string
): ScheduleTriggerValidation {
  const records = (Array.isArray(nodes) ? nodes : []).filter(
    (n): n is Record<string, unknown> => Boolean(n) && typeof n === 'object'
  );

  const scheduleLike = records.filter((n) => {
    const t = String(n.type ?? '').toLowerCase();
    return SCHEDULE_LIKE_SUBSTRINGS.some((s) => t.includes(s));
  });

  const canonicalNodes = scheduleLike.filter((n) => String(n.type).toLowerCase() === CANONICAL_SCHEDULE_TRIGGER_TYPE);
  const invalidTypes = Array.from(
    new Set(
      scheduleLike
        .filter((n) => String(n.type).toLowerCase() !== CANONICAL_SCHEDULE_TRIGGER_TYPE)
        .map((n) => String(n.type))
    )
  );

  if (canonicalNodes.length === 0) {
    return {
      ok: false,
      invalidTypes,
      reason:
        invalidTypes.length > 0
          ? `Generated an unsupported schedule trigger type (${invalidTypes.join(', ')}) instead of the canonical n8n-nodes-base.scheduleTrigger.`
          : 'Generated workflow is missing the required n8n-nodes-base.scheduleTrigger node.',
    };
  }

  if (invalidTypes.length > 0) {
    return {
      ok: false,
      invalidTypes,
      reason: `Generated workflow includes an unsupported extra schedule-like node type (${invalidTypes.join(', ')}) alongside the canonical trigger.`,
    };
  }

  for (const node of canonicalNodes) {
    const params = (node.parameters ?? {}) as Record<string, unknown>;
    const cronExpression = String(params.cronExpression ?? '').trim();
    const timezone = String(params.timezone ?? '').trim();

    if (!cronExpression) {
      return { ok: false, invalidTypes: [], reason: 'Generated schedule trigger is missing a cron expression.' };
    }

    try {
      cronParser.parseExpression(cronExpression, { tz: timezone || requiredTimezone || 'UTC' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid cron expression';
      return { ok: false, invalidTypes: [], reason: `Generated schedule trigger has an invalid cron expression "${cronExpression}": ${message}` };
    }

    if (!timezone) {
      return { ok: false, invalidTypes: [], reason: 'Generated schedule trigger is missing an explicit timezone.' };
    }
    if (timezone !== requiredTimezone) {
      return {
        ok: false,
        invalidTypes: [],
        reason: `Generated schedule trigger timezone "${timezone}" does not match the required timezone "${requiredTimezone}".`,
      };
    }
  }

  return { ok: true };
}
