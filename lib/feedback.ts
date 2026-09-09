import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.6 Section 3 — Product feedback.
 *
 * Backed by the proposed (currently UNAPPLIED) product_feedback migration
 * -- supabase/migrations/20260619000001_product_feedback.sql. Every
 * function here fails closed with a distinguishable "not configured yet"
 * result rather than a raw 500 if that table doesn't exist, so this
 * feature can ship in code now and simply light up the moment the
 * migration is reviewed and applied.
 */

export type FeedbackCategory = 'general' | 'bug' | 'feature_request';
export type FeedbackStatus = 'new' | 'reviewed' | 'resolved' | 'archived';

export type SubmitFeedbackParams = {
  userId: string;
  category: FeedbackCategory;
  rating?: number | null;
  comment?: string | null;
  pagePath?: string | null;
  appVersion?: string | null;
};

export type FeedbackRow = {
  id: string;
  user_id: string | null;
  category: FeedbackCategory;
  rating: number | null;
  comment: string | null;
  page_path: string | null;
  app_version: string | null;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
};

function isMissingTableError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  return err?.code === '42P01' || /relation .* does not exist/i.test(String(err?.message ?? ''));
}

export type SubmitFeedbackResult =
  | { ok: true; feedback: FeedbackRow }
  | { ok: false; reason: 'not_configured' | 'invalid' | 'db_error'; message: string };

const VALID_CATEGORIES: FeedbackCategory[] = ['general', 'bug', 'feature_request'];

export async function submitFeedback(params: SubmitFeedbackParams): Promise<SubmitFeedbackResult> {
  if (!VALID_CATEGORIES.includes(params.category)) {
    return { ok: false, reason: 'invalid', message: 'category must be one of: general, bug, feature_request' };
  }
  if (params.rating != null && (params.rating < 1 || params.rating > 5)) {
    return { ok: false, reason: 'invalid', message: 'rating must be between 1 and 5' };
  }
  const comment = params.comment?.trim() || null;
  if (!comment && params.rating == null) {
    return { ok: false, reason: 'invalid', message: 'Provide a rating, a comment, or both.' };
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('product_feedback')
    .insert({
      user_id: params.userId,
      category: params.category,
      rating: params.rating ?? null,
      comment,
      // Safe operational context only -- never a raw request object, never
      // headers, never workflow content. Truncated defensively in case a
      // caller ever passes something unexpectedly large.
      page_path: params.pagePath?.slice(0, 500) ?? null,
      app_version: params.appVersion?.slice(0, 100) ?? null,
    })
    .select()
    .single();

  if (error) {
    if (isMissingTableError(error)) {
      return { ok: false, reason: 'not_configured', message: 'Feedback is not available yet.' };
    }
    console.error('[feedback:submitFeedback]', error);
    return { ok: false, reason: 'db_error', message: 'Could not save feedback right now.' };
  }

  return { ok: true, feedback: data as FeedbackRow };
}

export type ListFeedbackResult =
  | { ok: true; rows: FeedbackRow[] }
  | { ok: false; reason: 'not_configured' | 'db_error'; message: string };

/** Admin-only listing -- caller must have already verified isAdminUser(). */
export async function listFeedback(params: { status?: FeedbackStatus; limit?: number } = {}): Promise<ListFeedbackResult> {
  const db = createServiceClient();
  let query = db.from('product_feedback').select('*').order('created_at', { ascending: false }).limit(params.limit ?? 200);
  if (params.status) query = query.eq('status', params.status);

  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) {
      return { ok: false, reason: 'not_configured', message: 'Feedback is not available yet.' };
    }
    console.error('[feedback:listFeedback]', error);
    return { ok: false, reason: 'db_error', message: 'Could not load feedback.' };
  }

  return { ok: true, rows: (data ?? []) as FeedbackRow[] };
}

/** Admin-only status update -- caller must have already verified isAdminUser(). */
export async function updateFeedbackStatus(id: string, status: FeedbackStatus): Promise<{ ok: boolean; message?: string }> {
  const db = createServiceClient();
  const { error } = await db
    .from('product_feedback')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    if (isMissingTableError(error)) return { ok: false, message: 'Feedback is not available yet.' };
    console.error('[feedback:updateFeedbackStatus]', error);
    return { ok: false, message: 'Could not update feedback status.' };
  }
  return { ok: true };
}
