import "server-only";

import { createServiceClient } from '@/lib/supabase-server';

export type IncidentType =
  | 'split_brain_prevented'
  | 'ownership_fenced'
  | 'worker_crash_repeated'
  | 'command_dead_letter'
  | 'replay_integrity_failure'
  | 'queue_congestion'
  | 'execution_loop'
  | 'dead_letter_spike';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus   = 'open' | 'investigating' | 'resolved';

export type Incident = {
  id:              string;
  incidentType:    IncidentType | string;
  severity:        IncidentSeverity;
  status:          IncidentStatus;
  executionId:     string | null;
  workflowId:      string | null;
  workerId:        string | null;
  userId:          string | null;
  title:           string;
  description:     string;
  occurrenceCount: number;
  firstSeenAt:     string;
  lastSeenAt:      string;
  resolvedAt:      string | null;
  resolvedBy:      string | null;
  details:         Record<string, unknown>;
  createdAt:       string;
  updatedAt:       string;
};

export type IncidentEvent = {
  id:         string;
  incidentId: string;
  eventType:  'created' | 'updated' | 'escalated' | 'resolved' | 'comment';
  actor:      string;
  payload:    Record<string, unknown>;
  createdAt:  string;
};

function mapIncidentRow(r: Record<string, unknown>): Incident {
  return {
    id:              String(r.id),
    incidentType:    String(r.incident_type) as IncidentType,
    severity:        String(r.severity) as IncidentSeverity,
    status:          String(r.status) as IncidentStatus,
    executionId:     r.execution_id != null ? String(r.execution_id) : null,
    workflowId:      r.workflow_id  != null ? String(r.workflow_id)  : null,
    workerId:        r.worker_id    != null ? String(r.worker_id)    : null,
    userId:          r.user_id      != null ? String(r.user_id)      : null,
    title:           String(r.title ?? ''),
    description:     String(r.description ?? ''),
    occurrenceCount: Number(r.occurrence_count ?? 1),
    firstSeenAt:     String(r.first_seen_at),
    lastSeenAt:      String(r.last_seen_at),
    resolvedAt:      r.resolved_at != null ? String(r.resolved_at) : null,
    resolvedBy:      r.resolved_by != null ? String(r.resolved_by) : null,
    details:         (r.details as Record<string, unknown>) ?? {},
    createdAt:       String(r.created_at),
    updatedAt:       String(r.updated_at),
  };
}

function mapIncidentEventRow(r: Record<string, unknown>): IncidentEvent {
  return {
    id:         String(r.id),
    incidentId: String(r.incident_id),
    eventType:  String(r.event_type) as IncidentEvent['eventType'],
    actor:      String(r.actor ?? 'system'),
    payload:    (r.payload as Record<string, unknown>) ?? {},
    createdAt:  String(r.created_at),
  };
}

// Opens a new incident or bumps the occurrence_count of an existing open/investigating one.
// Uses the open_or_bump_incident() SECURITY DEFINER RPC for atomic dedup.
export async function openIncident(params: {
  incidentType:  IncidentType | string;
  severity:      IncidentSeverity;
  title:         string;
  description?:  string;
  executionId?:  string | null;
  workflowId?:   string | null;
  workerId?:     string | null;
  userId?:       string | null;
  details?:      Record<string, unknown>;
}): Promise<{ incidentId: string; wasCreated: boolean } | null> {
  const db = createServiceClient();

  const { data, error } = await db.rpc('open_or_bump_incident', {
    p_incident_type: params.incidentType,
    p_severity:      params.severity,
    p_execution_id:  params.executionId  ?? null,
    p_workflow_id:   params.workflowId   ?? null,
    p_worker_id:     params.workerId     ?? null,
    p_user_id:       params.userId       ?? null,
    p_title:         params.title,
    p_description:   params.description  ?? '',
    p_details:       params.details      ?? {},
  });

  if (error || !data) return null;

  const rows = Array.isArray(data) ? data : [data];
  const row  = rows[0] as Record<string, unknown> | null;
  if (!row) return null;

  const incidentId = String(row.incident_id ?? '');
  const wasCreated = row.was_created === true;

  // Append audit event.
  await appendIncidentEvent({
    incidentId,
    eventType: wasCreated ? 'created' : 'updated',
    actor:     'system',
    payload:   {
      severity:        params.severity,
      occurrence_bump: !wasCreated,
      details:         params.details ?? {},
    },
  }).catch(() => undefined);

  return { incidentId, wasCreated };
}

// Appends a single audit event to an incident.
export async function appendIncidentEvent(params: {
  incidentId: string;
  eventType:  IncidentEvent['eventType'];
  actor?:     string;
  payload?:   Record<string, unknown>;
}): Promise<void> {
  const db = createServiceClient();
  await db.from('runtime_incident_events').insert({
    incident_id: params.incidentId,
    event_type:  params.eventType,
    actor:       params.actor   ?? 'system',
    payload:     params.payload ?? {},
    created_at:  new Date().toISOString(),
  });
}

// Marks an incident as resolved and appends a 'resolved' audit event.
export async function resolveIncident(params: {
  incidentId:  string;
  resolvedBy?: string;
  comment?:    string;
}): Promise<boolean> {
  const db = createServiceClient();
  const now = new Date().toISOString();

  const { error } = await db
    .from('runtime_incidents')
    .update({
      status:      'resolved',
      resolved_at: now,
      resolved_by: params.resolvedBy ?? 'operator',
      updated_at:  now,
    })
    .eq('id', params.incidentId)
    .in('status', ['open', 'investigating']);

  if (error) return false;

  await appendIncidentEvent({
    incidentId: params.incidentId,
    eventType:  'resolved',
    actor:      params.resolvedBy ?? 'operator',
    payload:    { comment: params.comment ?? null },
  }).catch(() => undefined);

  return true;
}

// Escalates an incident (updates severity + status → investigating) and appends audit event.
export async function escalateIncident(params: {
  incidentId:  string;
  toSeverity:  IncidentSeverity;
  escalatedBy?: string;
  reason?:      string;
}): Promise<boolean> {
  const db = createServiceClient();
  const now = new Date().toISOString();

  const { error } = await db
    .from('runtime_incidents')
    .update({
      severity:   params.toSeverity,
      status:     'investigating',
      updated_at: now,
    })
    .eq('id', params.incidentId)
    .in('status', ['open', 'investigating']);

  if (error) return false;

  await appendIncidentEvent({
    incidentId: params.incidentId,
    eventType:  'escalated',
    actor:      params.escalatedBy ?? 'operator',
    payload:    { to_severity: params.toSeverity, reason: params.reason ?? null },
  }).catch(() => undefined);

  return true;
}

// Lists all active (open + investigating) incidents, newest first.
// Pass userId to scope to a specific tenant; omit for admin (all tenants).
export async function listActiveIncidents(params?: {
  limit?:        number;
  severity?:     IncidentSeverity;
  incidentType?: string;
  userId?:       string;
}): Promise<Incident[]> {
  const db = createServiceClient();

  let q = db
    .from('runtime_incidents')
    .select('*')
    .in('status', ['open', 'investigating'])
    .order('last_seen_at', { ascending: false })
    .limit(params?.limit ?? 100);

  if (params?.severity) {
    q = q.eq('severity', params.severity);
  }
  if (params?.incidentType) {
    q = q.eq('incident_type', params.incidentType);
  }
  if (params?.userId) {
    q = q.eq('user_id', params.userId);
  }

  const { data } = await q;
  return (data ?? []).map((r) => mapIncidentRow(r as unknown as Record<string, unknown>));
}

// Returns a single incident with its full audit trail.
// Pass userId to verify the incident belongs to that tenant; returns null if it doesn't.
// Ownership is confirmed before runtime_incident_events is queried.
export async function getIncidentById(incidentId: string, userId?: string): Promise<{
  incident:       Incident;
  incidentEvents: IncidentEvent[];
} | null> {
  const db = createServiceClient();

  let incidentQ = db.from('runtime_incidents').select('*').eq('id', incidentId).limit(1);
  if (userId) incidentQ = incidentQ.eq('user_id', userId);

  const incidentRes = await incidentQ.maybeSingle();
  if (!incidentRes.data) return null;

  const eventsRes = await db
    .from('runtime_incident_events')
    .select('*')
    .eq('incident_id', incidentId)
    .order('created_at', { ascending: true })
    .limit(200);

  return {
    incident:       mapIncidentRow(incidentRes.data as unknown as Record<string, unknown>),
    incidentEvents: (eventsRes.data ?? []).map((r) =>
      mapIncidentEventRow(r as unknown as Record<string, unknown>)
    ),
  };
}

// Records an operator action in the audit log.
export async function recordOperatorAction(params: {
  actionType:  string;
  operatorId:  string;
  executionId?: string | null;
  workflowId?:  string | null;
  workerId?:    string | null;
  incidentId?:  string | null;
  payload?:     Record<string, unknown>;
  result?:      Record<string, unknown>;
}): Promise<void> {
  const db = createServiceClient();
  await db.from('runtime_operator_actions').insert({
    action_type:  params.actionType,
    operator_id:  params.operatorId,
    execution_id: params.executionId ?? null,
    workflow_id:  params.workflowId  ?? null,
    worker_id:    params.workerId    ?? null,
    incident_id:  params.incidentId  ?? null,
    payload:      params.payload     ?? {},
    result:       params.result      ?? {},
    created_at:   new Date().toISOString(),
  });
}
