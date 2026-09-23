/**
 * Phase 9.9.21 -- Part 6: owner-only start/stop for a Test Connection
 * session. See lib/workflow/webhook-test-mode.ts for the safety model
 * (refuses to arm for an already-active/executable workflow).
 *
 * POST /api/workflows/[id]/connection/test  { action: 'start', ttlMinutes? } | { action: 'stop' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { startTestMode, stopTestMode } from '@/lib/workflow/webhook-test-mode';

type Ctx = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; ttlMinutes?: number };

  if (body.action === 'start') {
    const result = await startTestMode(user.id, params.id, body.ttlMinutes);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ success: true, testMode: result.state });
  }

  if (body.action === 'stop') {
    const result = await stopTestMode(user.id, params.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ success: true, testMode: result.state });
  }

  return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
}
