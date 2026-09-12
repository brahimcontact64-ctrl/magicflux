/**
 * Per-workflow webhook authentication secret — Phase 9.8.4.
 *
 * GET  /api/workflows/[id]/webhook-secret
 *   Owner-only. Returns the workflow's current webhook secret, provisioning
 *   one on the spot (backfill) if the workflow has a webhook trigger and
 *   none yet — covers workflows activated before this fix existed, without
 *   any bulk/tenant-wide migration.
 *
 * POST /api/workflows/[id]/webhook-secret  { action: 'rotate' }
 *   Owner-only. Generates a brand-new secret, overwriting the old one in
 *   place (old value stops working immediately). No new workflow, no new
 *   deployment version.
 *
 * Never logs or echoes the secret anywhere but this authenticated,
 * owner-scoped JSON response.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { ensureWebhookSecret, rotateWebhookSecret } from '@/lib/workflow/webhook-secret';

type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await ensureWebhookSecret(user.id, params.id);
  if (!result.hasWebhookTrigger) {
    return NextResponse.json({ error: 'Workflow not found or has no webhook trigger' }, { status: 404 });
  }

  return NextResponse.json({ success: true, hasWebhookTrigger: true, secret: result.secret });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (body.action !== 'rotate') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }

  const result = await rotateWebhookSecret(user.id, params.id);
  if (!result.hasWebhookTrigger) {
    return NextResponse.json({ error: 'Workflow not found or has no webhook trigger' }, { status: 404 });
  }

  return NextResponse.json({ success: true, hasWebhookTrigger: true, secret: result.secret });
}
