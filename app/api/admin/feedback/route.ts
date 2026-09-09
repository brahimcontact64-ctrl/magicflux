import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest, isAdminUser } from '@/lib/supabase-server';
import { listFeedback, updateFeedbackStatus, type FeedbackStatus } from '@/lib/feedback';

const VALID_STATUSES: FeedbackStatus[] = ['new', 'reviewed', 'resolved', 'archived'];

/**
 * GET /api/admin/feedback — Founder/Admin feedback inbox.
 * PATCH /api/admin/feedback — update one row's status.
 *
 * Phase 9.6 Section 3. Server-side isAdminUser() enforcement, matching
 * every other admin route in this codebase — never a client-supplied
 * admin flag.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = await isAdminUser(user.id);
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const status = req.nextUrl.searchParams.get('status') as FeedbackStatus | null;
  const result = await listFeedback({ status: status && VALID_STATUSES.includes(status) ? status : undefined });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason, message: result.message }, { status: result.reason === 'not_configured' ? 503 : 500 });
  }

  return NextResponse.json({ success: true, rows: result.rows });
}

export async function PATCH(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = await isAdminUser(user.id);
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { id?: string; status?: string };
  if (!body.id || !VALID_STATUSES.includes(body.status as FeedbackStatus)) {
    return NextResponse.json({ error: 'id and a valid status are required' }, { status: 400 });
  }

  const result = await updateFeedbackStatus(body.id, body.status as FeedbackStatus);
  if (!result.ok) {
    return NextResponse.json({ error: 'update_failed', message: result.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
