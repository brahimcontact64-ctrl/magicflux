import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/runtime/rbac';
import {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getRecentFirings,
  fireAlert,
  type AlertConditionType,
  type AlertChannel,
  type AlertChannelConfig,
} from '@/lib/runtime/alert-engine';

const VALID_CONDITIONS: AlertConditionType[] = [
  'queue_overload', 'worker_crash', 'incident_explosion',
  'replay_corruption', 'sla_violation',
];

const VALID_CHANNELS: AlertChannel[] = [
  'dashboard', 'email', 'webhook', 'slack', 'telegram',
];

// GET — list alert rules and recent firings.
//
// Query params:
//   ?rule_id=<uuid>   — get a single rule + its recent firings
//   ?firings=true     — list recent firings (last 100)
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp     = req.nextUrl.searchParams;
  const ruleId = sp.get('rule_id');

  if (ruleId) {
    const [rule, firings] = await Promise.all([
      getAlertRule(ruleId),
      getRecentFirings({ ruleId, limit: 50 }),
    ]);

    if (!rule) return NextResponse.json({ error: 'Alert rule not found' }, { status: 404 });
    return NextResponse.json({ rule, firings });
  }

  if (sp.get('firings') === 'true') {
    const firings = await getRecentFirings({ limit: 100 });
    return NextResponse.json({ firings, count: firings.length, generatedAt: new Date().toISOString() });
  }

  const rules = await listAlertRules();
  return NextResponse.json({ rules, count: rules.length, generatedAt: new Date().toISOString() });
}

// POST — CRUD + test actions on alert rules.
//
// Body variants:
//   { action: 'create'; name; conditionType; threshold; windowMinutes; severity; channels; channelConfig }
//   { action: 'update'; ruleId; patch: { ... } }
//   { action: 'delete'; ruleId }
//   { action: 'test';   ruleId }
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'manage_incidents');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const { action } = b;

  if (action === 'create') {
    const { name, conditionType, threshold, windowMinutes, severity, channels, channelConfig } = b;

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (typeof conditionType !== 'string' || !VALID_CONDITIONS.includes(conditionType as AlertConditionType)) {
      return NextResponse.json(
        { error: `conditionType must be one of: ${VALID_CONDITIONS.join(', ')}` },
        { status: 400 }
      );
    }
    if (typeof threshold !== 'number' || threshold < 1) {
      return NextResponse.json({ error: 'threshold must be a positive integer' }, { status: 400 });
    }
    if (typeof windowMinutes !== 'number' || windowMinutes < 1) {
      return NextResponse.json({ error: 'windowMinutes must be a positive integer' }, { status: 400 });
    }

    const safeChannels: AlertChannel[] = Array.isArray(channels)
      ? (channels as string[]).filter(c => VALID_CHANNELS.includes(c as AlertChannel)) as AlertChannel[]
      : ['dashboard'];

    const rule = await createAlertRule({
      name:          name.trim(),
      conditionType: conditionType as AlertConditionType,
      threshold:     threshold as number,
      windowMinutes: windowMinutes as number,
      severity:      typeof severity === 'string' ? severity : 'warning',
      channels:      safeChannels,
      channelConfig: (channelConfig ?? {}) as AlertChannelConfig,
      createdBy:     user.id,
    });

    return NextResponse.json({ action, rule });
  }

  if (action === 'update') {
    const { ruleId, patch } = b;
    if (typeof ruleId !== 'string' || !ruleId) {
      return NextResponse.json({ error: 'ruleId is required' }, { status: 400 });
    }
    if (!patch || typeof patch !== 'object') {
      return NextResponse.json({ error: 'patch is required' }, { status: 400 });
    }

    const ok = await updateAlertRule(ruleId as string, patch as Parameters<typeof updateAlertRule>[1]);
    if (!ok) return NextResponse.json({ error: 'Rule not found or update failed' }, { status: 404 });

    return NextResponse.json({ action, ruleId, updated: true });
  }

  if (action === 'delete') {
    const { ruleId } = b;
    if (typeof ruleId !== 'string' || !ruleId) {
      return NextResponse.json({ error: 'ruleId is required' }, { status: 400 });
    }

    const ok = await deleteAlertRule(ruleId as string);
    if (!ok) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

    return NextResponse.json({ action, ruleId, deleted: true });
  }

  if (action === 'test') {
    const { ruleId } = b;
    if (typeof ruleId !== 'string' || !ruleId) {
      return NextResponse.json({ error: 'ruleId is required' }, { status: 400 });
    }

    const rule = await getAlertRule(ruleId as string);
    if (!rule) return NextResponse.json({ error: 'Alert rule not found' }, { status: 404 });

    const firingId = await fireAlert(rule, {
      test:        true,
      triggered_by: user.id,
      ts:          new Date().toISOString(),
    });

    return NextResponse.json({ action, ruleId, firingId, fired: true });
  }

  return NextResponse.json(
    { error: "action must be 'create', 'update', 'delete', or 'test'" },
    { status: 400 }
  );
}
