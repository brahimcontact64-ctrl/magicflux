import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { getUserPermissions, requirePermission } from '@/lib/runtime/rbac';
import {
  listActiveIncidents,
  getIncidentById,
  resolveIncident,
  escalateIncident,
  appendIncidentEvent,
  recordOperatorAction,
  type IncidentSeverity,
} from '@/lib/runtime/incident-manager';

// GET — list incidents or fetch a single incident with its audit trail.
//
// Query params:
//   ?id=<uuid>            — fetch single incident + events
//   ?status=<s>           — filter (open|investigating|resolved), default: open+investigating
//   ?severity=<s>         — filter by severity
//   ?incident_type=<t>    — filter by incident type
//   ?limit=<n>            — default 100
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const scopedUserId = isAdmin ? undefined : user.id;

  const sp = req.nextUrl.searchParams;
  const id = sp.get('id');

  if (id) {
    const result = await getIncidentById(id, scopedUserId);
    if (!result) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    return NextResponse.json(result);
  }

  const severity     = sp.get('severity') as IncidentSeverity | null;
  const incidentType = sp.get('incident_type') ?? undefined;
  const limitRaw     = parseInt(sp.get('limit') ?? '100', 10);
  const limit        = Math.min(500, Math.max(1, isNaN(limitRaw) ? 100 : limitRaw));

  const incidents = await listActiveIncidents({
    limit,
    severity:     severity ?? undefined,
    incidentType,
    userId:       scopedUserId,
  });

  return NextResponse.json({
    incidents,
    count:       incidents.length,
    generatedAt: new Date().toISOString(),
  });
}

// POST — operator actions on incidents.
//
// Body variants:
//   { action: 'resolve';   incidentId: string; comment?: string }
//   { action: 'escalate';  incidentId: string; toSeverity: string; reason?: string }
//   { action: 'comment';   incidentId: string; comment: string }
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

  const { action, incidentId } = body as { action?: string; incidentId?: unknown };

  const isBulkAction = action === 'bulk_resolve' || action === 'bulk_escalate';
  if (!isBulkAction && (typeof incidentId !== 'string' || !incidentId)) {
    return NextResponse.json({ error: 'incidentId is required' }, { status: 400 });
  }

  // Safe for non-bulk single-action handlers — validated above.
  const singleId = (incidentId ?? '') as string;

  if (action === 'resolve') {
    const comment = typeof (body as Record<string, unknown>).comment === 'string'
      ? String((body as Record<string, unknown>).comment) : undefined;

    const ok = await resolveIncident({ incidentId: singleId, resolvedBy: user.id, comment });
    if (!ok) return NextResponse.json({ error: 'Incident not found or already resolved' }, { status: 404 });

    await recordOperatorAction({
      actionType:  'resolve_incident',
      operatorId:  user.id,
      incidentId:  singleId,
      payload:     { comment: comment ?? null },
      result:      { resolved: true },
    }).catch(() => undefined);

    return NextResponse.json({ action, incidentId: singleId, resolved: true });
  }

  if (action === 'escalate') {
    const toSeverity = (body as Record<string, unknown>).toSeverity;
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (typeof toSeverity !== 'string' || !validSeverities.includes(toSeverity)) {
      return NextResponse.json({ error: 'toSeverity must be low|medium|high|critical' }, { status: 400 });
    }
    const reason = typeof (body as Record<string, unknown>).reason === 'string'
      ? String((body as Record<string, unknown>).reason) : undefined;

    const ok = await escalateIncident({
      incidentId:  singleId,
      toSeverity:  toSeverity as IncidentSeverity,
      escalatedBy: user.id,
      reason,
    });
    if (!ok) return NextResponse.json({ error: 'Incident not found or already resolved' }, { status: 404 });

    await recordOperatorAction({
      actionType:  'escalate_incident',
      operatorId:  user.id,
      incidentId:  singleId,
      payload:     { toSeverity, reason: reason ?? null },
      result:      { escalated: true },
    }).catch(() => undefined);

    return NextResponse.json({ action, incidentId: singleId, escalated: true, toSeverity });
  }

  if (action === 'comment') {
    const comment = (body as Record<string, unknown>).comment;
    if (typeof comment !== 'string' || !comment.trim()) {
      return NextResponse.json({ error: 'comment is required' }, { status: 400 });
    }

    await appendIncidentEvent({
      incidentId: singleId,
      eventType: 'comment',
      actor:     user.id,
      payload:   { comment },
    });

    await recordOperatorAction({
      actionType:  'comment_incident',
      operatorId:  user.id,
      incidentId:  singleId,
      payload:     { comment },
      result:      { commented: true },
    }).catch(() => undefined);

    return NextResponse.json({ action, incidentId: singleId, commented: true });
  }

  if (action === 'bulk_resolve') {
    const ids = (body as Record<string, unknown>).incidentIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
      return NextResponse.json({ error: 'incidentIds must be a non-empty string array' }, { status: 400 });
    }
    const comment = typeof (body as Record<string, unknown>).comment === 'string'
      ? String((body as Record<string, unknown>).comment) : undefined;

    const results = await Promise.all(
      (ids as string[]).map(id => resolveIncident({ incidentId: id, resolvedBy: user.id, comment }))
    );
    const resolved = results.filter(Boolean).length;

    await recordOperatorAction({
      actionType: 'bulk_resolve_incidents',
      operatorId:  user.id,
      payload:     { incidentIds: ids, comment: comment ?? null },
      result:      { resolved, total: ids.length },
    }).catch(() => undefined);

    return NextResponse.json({ action, resolved, total: ids.length });
  }

  if (action === 'bulk_escalate') {
    const ids = (body as Record<string, unknown>).incidentIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
      return NextResponse.json({ error: 'incidentIds must be a non-empty string array' }, { status: 400 });
    }
    const toSeverity = (body as Record<string, unknown>).toSeverity;
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (typeof toSeverity !== 'string' || !validSeverities.includes(toSeverity)) {
      return NextResponse.json({ error: 'toSeverity must be low|medium|high|critical' }, { status: 400 });
    }

    const results = await Promise.all(
      (ids as string[]).map(id =>
        escalateIncident({ incidentId: id, toSeverity: toSeverity as IncidentSeverity, escalatedBy: user.id })
      )
    );
    const escalated = results.filter(Boolean).length;

    await recordOperatorAction({
      actionType: 'bulk_escalate_incidents',
      operatorId:  user.id,
      payload:     { incidentIds: ids, toSeverity },
      result:      { escalated, total: ids.length },
    }).catch(() => undefined);

    return NextResponse.json({ action, escalated, total: ids.length, toSeverity });
  }

  return NextResponse.json(
    { error: "action must be 'resolve', 'escalate', 'comment', 'bulk_resolve', or 'bulk_escalate'" },
    { status: 400 }
  );
}
