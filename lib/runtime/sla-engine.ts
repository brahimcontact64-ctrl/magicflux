import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

export type SlaTargetType =
  | 'execution_duration'
  | 'worker_availability'
  | 'queue_latency'
  | 'command_ack_time';

export type SlaViolationSeverity = 'warning' | 'violated';

export type SlaTarget = {
  id:           string;
  target_type:  SlaTargetType;
  threshold_ms: number;
  warning_pct:  number;
  description:  string | null;
  is_active:    boolean;
  created_at:   string;
};

export type SlaViolation = {
  id:              string;
  target_id:       string | null;
  target_type:     string;
  severity:        SlaViolationSeverity;
  actual_value_ms: number;
  threshold_ms:    number;
  execution_id:    string | null;
  worker_id:       string | null;
  command_id:      string | null;
  details:         Record<string, unknown>;
  recorded_at:     string;
};

export type SlaReport = {
  targets:         SlaTarget[];
  recentViolations: SlaViolation[];
  complianceByType: Record<string, { total: number; violated: number; compliancePct: number }>;
  windowHours:     number;
};

export async function getSlaTargets(): Promise<SlaTarget[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_sla_targets')
    .select('*')
    .eq('is_active', true)
    .order('target_type');

  return (data ?? []) as SlaTarget[];
}

export async function upsertSlaTarget(params: {
  targetType:  SlaTargetType;
  thresholdMs: number;
  warningPct?: number;
  description?: string;
}): Promise<SlaTarget> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('runtime_sla_targets')
    .upsert({
      target_type:  params.targetType,
      threshold_ms: params.thresholdMs,
      warning_pct:  params.warningPct ?? 80,
      description:  params.description ?? null,
      is_active:    true,
    }, { onConflict: 'target_type' })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to upsert SLA target: ${error?.message}`);
  return data as SlaTarget;
}

export async function recordSlaViolation(params: {
  targetType:    string;
  severity:      SlaViolationSeverity;
  actualValueMs: number;
  thresholdMs:   number;
  executionId?:  string;
  workerId?:     string;
  commandId?:    string;
  details?:      Record<string, unknown>;
}): Promise<string> {
  const db = createServiceClient();

  const { data: target } = await db
    .from('runtime_sla_targets')
    .select('id')
    .eq('target_type', params.targetType)
    .eq('is_active', true)
    .maybeSingle();

  const { data } = await db
    .from('runtime_sla_violations')
    .insert({
      target_id:       target?.id ?? null,
      target_type:     params.targetType,
      severity:        params.severity,
      actual_value_ms: params.actualValueMs,
      threshold_ms:    params.thresholdMs,
      execution_id:    params.executionId ?? null,
      worker_id:       params.workerId    ?? null,
      command_id:      params.commandId   ?? null,
      details:         params.details     ?? {},
    })
    .select('id')
    .single();

  return data?.id ?? '';
}

export async function checkExecutionSla(params: {
  executionId: string;
  startedAt:   string;
  completedAt: string;
}): Promise<SlaViolationSeverity | null> {
  const db = createServiceClient();
  const { data: target } = await db
    .from('runtime_sla_targets')
    .select('*')
    .eq('target_type', 'execution_duration')
    .eq('is_active', true)
    .maybeSingle();

  if (!target) return null;

  const actualMs = new Date(params.completedAt).getTime() -
                   new Date(params.startedAt).getTime();
  const warningMs = Math.floor((target.threshold_ms * target.warning_pct) / 100);

  if (actualMs >= target.threshold_ms) {
    await recordSlaViolation({
      targetType:    'execution_duration',
      severity:      'violated',
      actualValueMs: actualMs,
      thresholdMs:   target.threshold_ms,
      executionId:   params.executionId,
      details:       { started_at: params.startedAt, completed_at: params.completedAt },
    });
    return 'violated';
  }

  if (actualMs >= warningMs) {
    await recordSlaViolation({
      targetType:    'execution_duration',
      severity:      'warning',
      actualValueMs: actualMs,
      thresholdMs:   target.threshold_ms,
      executionId:   params.executionId,
      details:       { started_at: params.startedAt, completed_at: params.completedAt },
    });
    return 'warning';
  }

  return null;
}

export async function getRecentViolations(windowHours: number = 24): Promise<SlaViolation[]> {
  const db = createServiceClient();
  const since = new Date(Date.now() - windowHours * 60 * 60_000).toISOString();

  const { data } = await db
    .from('runtime_sla_violations')
    .select('*')
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: false })
    .limit(500);

  return (data ?? []) as SlaViolation[];
}

export async function getSlaReport(windowHours: number = 24): Promise<SlaReport> {
  const [targets, violations] = await Promise.all([
    getSlaTargets(),
    getRecentViolations(windowHours),
  ]);

  const complianceByType: Record<string, { total: number; violated: number; compliancePct: number }> = {};

  for (const v of violations) {
    if (!complianceByType[v.target_type]) {
      complianceByType[v.target_type] = { total: 0, violated: 0, compliancePct: 100 };
    }
    complianceByType[v.target_type].total++;
    if (v.severity === 'violated') {
      complianceByType[v.target_type].violated++;
    }
  }

  for (const entry of Object.values(complianceByType)) {
    entry.compliancePct = entry.total > 0
      ? Math.round(((entry.total - entry.violated) / entry.total) * 100)
      : 100;
  }

  return {
    targets,
    recentViolations: violations.slice(0, 100),
    complianceByType,
    windowHours,
  };
}
