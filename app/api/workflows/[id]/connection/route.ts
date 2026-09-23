/**
 * Phase 9.9.21 -- Part 1: single source of truth for the Connection Guide
 * page. Owner-only.
 *
 * GET /api/workflows/[id]/connection
 *   Returns the workflow's OWN derived trigger fields (never a hardcoded
 *   global list -- see lib/connection-guide/trigger-fields.ts), whether a
 *   Test Connection session is currently armed, its most recent event, and
 *   the last genuinely successful (non-blocked) inbound webhook request
 *   this workflow has ever received, if any -- timestamp only, never the
 *   payload, matching this codebase's existing webhook-log redaction
 *   posture.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { deriveTriggerFields } from '@/lib/connection-guide/trigger-fields';
import { extractTestModeState } from '@/lib/workflow/webhook-test-mode';
import { hasWebhookTrigger } from '@/lib/workflow/webhook-secret';

type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data: workflow } = await db
    .from('workflows')
    .select('id, workflow_json, status')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!workflow || !hasWebhookTrigger(workflow.workflow_json)) {
    return NextResponse.json({ error: 'Workflow not found or has no webhook trigger' }, { status: 404 });
  }

  const fields = deriveTriggerFields(workflow.workflow_json);

  const { data: lastSuccess } = await db
    .from('runtime_webhook_request_log')
    .select('created_at')
    .eq('workflow_id', workflow.id)
    .eq('blocked', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    status: workflow.status,
    requiredFields: fields.filter((f) => f.required).map((f) => f.name),
    optionalFields: fields.filter((f) => !f.required).map((f) => f.name),
    lastSuccessfulEventAt: lastSuccess?.created_at ?? null,
    testMode: extractTestModeState(workflow.workflow_json),
  });
}
