/**
 * Phase 9.8.8 — Schedule Contract Truth.
 *
 * Root cause (production investigation, Founder Schedule -> Gmail attempt):
 * the `trigger: 'schedule'` generation path gave the model a raw free-text
 * `schedule` string with zero contract on the required node type/parameter
 * shape and zero timezone context, so it invented an unrecognized node type
 * instead of the canonical n8n-nodes-base.scheduleTrigger, and had no
 * mechanism to represent an absolute one-time request or a real timezone
 * (silently defaulting to UTC downstream in lib/runtime/scheduler.ts).
 *
 * This suite pins the three deterministic, fail-closed guards added in
 * lib/agent/schedule-guard.ts as the backstop behind the strengthened
 * generation prompt.
 */

import { describe, it, expect } from 'vitest';
import {
  detectOneTimeSchedulePhrase,
  isValidIanaTimezone,
  validateCanonicalScheduleTrigger,
  ONE_TIME_SCHEDULE_REJECTION_MESSAGE,
} from '../lib/agent/schedule-guard';
import { checkConcreteValuesPreserved } from '../lib/agent/concrete-value-guard';

describe('detectOneTimeSchedulePhrase', () => {
  it('rejects the exact production regression phrase: "today at 14:45"', () => {
    expect(detectOneTimeSchedulePhrase('today at 14:45')).toBe(true);
  });

  it('rejects "tomorrow at 9am"', () => {
    expect(detectOneTimeSchedulePhrase('tomorrow at 9am')).toBe(true);
  });

  it('rejects a specific calendar date ("on September 20 at 3pm")', () => {
    expect(detectOneTimeSchedulePhrase('on September 20 at 3pm')).toBe(true);
  });

  it('rejects a specific numeric date ("9/20 at 15:00")', () => {
    expect(detectOneTimeSchedulePhrase('9/20 at 15:00')).toBe(true);
  });

  it('accepts "every 5 minutes" as recurring, not one-time', () => {
    expect(detectOneTimeSchedulePhrase('every 5 minutes')).toBe(false);
  });

  it('accepts "daily at 09:00" as recurring, not one-time', () => {
    expect(detectOneTimeSchedulePhrase('daily at 09:00')).toBe(false);
  });

  it('accepts "every Monday at 09:00" as recurring, not one-time', () => {
    expect(detectOneTimeSchedulePhrase('every Monday at 09:00')).toBe(false);
  });

  it('a recurring marker wins even alongside a one-time word (e.g. "every day starting today")', () => {
    expect(detectOneTimeSchedulePhrase('every day starting today')).toBe(false);
  });

  it('empty/blank schedule text is not flagged as one-time (nothing to detect)', () => {
    expect(detectOneTimeSchedulePhrase('')).toBe(false);
    expect(detectOneTimeSchedulePhrase('   ')).toBe(false);
  });

  it('the honest rejection message names the unsupported gap and offers real recurring alternatives', () => {
    expect(ONE_TIME_SCHEDULE_REJECTION_MESSAGE).toMatch(/one-time/i);
    expect(ONE_TIME_SCHEDULE_REJECTION_MESSAGE).toMatch(/not supported/i);
    expect(ONE_TIME_SCHEDULE_REJECTION_MESSAGE).toMatch(/every 5 minutes/i);
    expect(ONE_TIME_SCHEDULE_REJECTION_MESSAGE).toMatch(/daily at 09:00/i);
  });
});

describe('isValidIanaTimezone', () => {
  it('accepts the Founder acceptance-test timezone, Africa/Algiers', () => {
    expect(isValidIanaTimezone('Africa/Algiers')).toBe(true);
  });

  it('accepts UTC and other real IANA zones', () => {
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
  });

  it('rejects empty/missing timezone -- never silently defaults', () => {
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone('   ')).toBe(false);
  });

  it('rejects a garbage/invented timezone string', () => {
    expect(isValidIanaTimezone('Not/A_Real_Zone')).toBe(false);
    expect(isValidIanaTimezone('GMT+1 local time')).toBe(false);
  });
});

describe('validateCanonicalScheduleTrigger', () => {
  const REQUIRED_TZ = 'Africa/Algiers';

  function scheduleNode(overrides: Record<string, unknown> = {}) {
    return {
      id: '1',
      name: 'Schedule Trigger',
      type: 'n8n-nodes-base.scheduleTrigger',
      parameters: { cronExpression: '0 9 * * *', timezone: REQUIRED_TZ },
      ...overrides,
    };
  }

  it('accepts "every 5 minutes" represented as a canonical scheduleTrigger with a 5-field cron', () => {
    const nodes = [scheduleNode({ parameters: { cronExpression: '*/5 * * * *', timezone: REQUIRED_TZ } })];
    expect(validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ)).toEqual({ ok: true });
  });

  it('accepts "daily at 09:00" as a valid 5-field cron ("0 9 * * *")', () => {
    const nodes = [scheduleNode()];
    expect(validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ)).toEqual({ ok: true });
  });

  it('preserves and requires the exact explicit timezone -- rejects a mismatch (e.g. a silent UTC substitution)', () => {
    const nodes = [scheduleNode({ parameters: { cronExpression: '0 9 * * *', timezone: 'UTC' } })];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timezone/i);
  });

  it('rejects a missing timezone on the generated node', () => {
    const nodes = [scheduleNode({ parameters: { cronExpression: '0 9 * * *' } })];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing/invalid cron expression', () => {
    const nodes = [scheduleNode({ parameters: { cronExpression: 'not a cron', timezone: REQUIRED_TZ } })];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cron/i);
  });

  it('fails closed on an invented alternate node type (the exact production failure mode -- e.g. legacy n8n-nodes-base.cron)', () => {
    const nodes = [scheduleNode({ type: 'n8n-nodes-base.cron' })];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalidTypes).toContain('n8n-nodes-base.cron');
      expect(result.reason).toMatch(/scheduleTrigger/);
    }
  });

  it('fails closed on an invented wait/timer-style trigger substitute', () => {
    const nodes = [scheduleNode({ name: 'Timer', type: 'n8n-nodes-base.intervalTimer' })];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
  });

  it('rejects a workflow missing a schedule trigger node entirely', () => {
    const nodes = [{ id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: {} }];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
  });

  it('rejects a canonical trigger alongside an extra invented schedule-like node', () => {
    const nodes = [scheduleNode(), { id: '2', name: 'Also Cron', type: 'n8n-nodes-base.cron', parameters: {} }];
    const result = validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ);
    expect(result.ok).toBe(false);
  });

  it('does not flag an unrelated non-schedule-like action node (e.g. Gmail) as invalid', () => {
    const nodes = [scheduleNode(), { id: '2', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'nssmpro@gmail.com' } }];
    expect(validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ)).toEqual({ ok: true });
  });
});

describe('Phase 9.8.8 -- schedule + Gmail: concrete-value preservation remains intact alongside the new schedule guard', () => {
  it('a correctly-generated Schedule Trigger -> Gmail workflow passes BOTH the schedule guard and the existing concrete-value guard', () => {
    const REQUIRED_TZ = 'Africa/Algiers';
    const nodes = [
      { id: '1', name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: '0 9 * * *', timezone: REQUIRED_TZ } },
      {
        id: '2',
        name: 'Send Email',
        type: 'n8n-nodes-base.gmail',
        parameters: {
          to: 'nssmpro@gmail.com',
          subject: 'MagicFlux Scheduled Test',
          message: 'This email was automatically sent by MagicFlux at the scheduled time',
        },
      },
    ];
    const rawUserIntent =
      'Send an email to nssmpro@gmail.com every day at 09:00 with the subject "MagicFlux Scheduled Test" ' +
      'and the message "This email was automatically sent by MagicFlux at the scheduled time".';

    expect(validateCanonicalScheduleTrigger(nodes, REQUIRED_TZ)).toEqual({ ok: true });

    const concreteCheck = checkConcreteValuesPreserved(rawUserIntent, nodes);
    expect(concreteCheck.ok).toBe(true);
  });
});
