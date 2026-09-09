import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { submitFeedback, type FeedbackCategory } from '@/lib/feedback';

/**
 * POST /api/feedback
 *
 * Phase 9.6 Section 3 — first-party product feedback. Attaches only safe
 * operational context (the authenticated user id from the verified JWT,
 * the page path and app version the client reports about itself, and a
 * server timestamp) -- never an authorization header, credential,
 * workflow_json, or raw execution payload. Workflow/prompt content is
 * included only if the user explicitly types it into the comment field
 * themselves; nothing here reads or attaches it automatically.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    category?: string;
    rating?: number;
    comment?: string;
    pagePath?: string;
  };

  const category = body.category as FeedbackCategory;
  const appVersion = req.headers.get('x-app-version') ?? process.env.NEXT_PUBLIC_APP_VERSION ?? null;

  const result = await submitFeedback({
    userId: user.id,
    category,
    rating: typeof body.rating === 'number' ? body.rating : null,
    comment: body.comment,
    pagePath: body.pagePath,
    appVersion,
  });

  if (!result.ok) {
    const status =
      result.reason === 'invalid' ? 400 :
      result.reason === 'rate_limited' ? 429 :
      result.reason === 'not_configured' ? 503 : 500;
    return NextResponse.json({ error: result.reason, message: result.message }, { status });
  }

  return NextResponse.json({ success: true, id: result.feedback.id });
}
