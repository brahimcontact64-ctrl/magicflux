import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { attemptAcknowledgmentResume } from '@/lib/runtime/acknowledgment-resume';

type Ctx = { params: { id: string } };

/**
 * Incident 9.9.17I -- two independent live executions were acknowledged
 * ~6.6 seconds after their challenge was created, both times with the
 * human stating they had not clicked the link. The GET handler performed
 * the CAS mutation itself, so ANY automated fetch of the URL -- a link
 * scanner, a prefetcher, an email security gateway, a browser's own
 * speculative navigation -- silently consumed the one-time acknowledgment
 * before a human ever saw it. Which specific system did it is unproven and
 * irrelevant: a GET that mutates is unsafe by HTTP's own semantics
 * (RFC 7231 SS4.2.1 -- GET/HEAD must be safe/side-effect-free), regardless
 * of which client issues it.
 *
 * New contract: GET never mutates acknowledgment state, under any
 * repetition, header shape, or request count -- it only ever reads and
 * renders. The rendered page's only path to a mutation is a real HTML
 * <form method="POST">, which no prefetcher/scanner/speculative-navigation
 * mechanism ever submits (they fetch resources; they do not fill in and
 * submit forms). Only POST may attempt the pending -> acknowledged CAS.
 */
function htmlPage(opts: { title: string; message: string; icon: string; formAction?: string; formToken?: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const form = opts.formAction
    ? `
    <form method="POST" action="${esc(opts.formAction)}">
      <input type="hidden" name="token" value="${esc(opts.formToken ?? '')}">
      <button type="submit" class="btn">Acknowledge Lead</button>
    </form>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MagicFlux</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0b0b10; color: #f2f2f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
  .card { max-width: 420px; }
  .icon { font-size: 44px; margin-bottom: 16px; line-height: 1; }
  h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
  p { font-size: 15px; color: #a8a8b3; margin: 0 0 20px; line-height: 1.5; }
  .btn { appearance: none; border: none; border-radius: 10px; padding: 14px 28px; font-size: 16px; font-weight: 600; background: #f2f2f5; color: #0b0b10; cursor: pointer; }
  .btn:active { opacity: 0.85; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${opts.icon}</div>
    <h1>${esc(opts.title)}</h1>
    <p>${esc(opts.message)}</p>
    ${form}
  </div>
</body>
</html>`;
}

function htmlResponse(status: number, opts: { title: string; message: string; icon: string; formAction?: string; formToken?: string }): NextResponse {
  return new NextResponse(htmlPage(opts), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const ACKNOWLEDGED_PAGE = { icon: '✅', title: 'Lead acknowledged', message: 'Lead acknowledged successfully. The workflow will continue automatically.' };
const ALREADY_ACKNOWLEDGED_PAGE = { icon: '✅', title: 'Already acknowledged', message: 'This lead has already been acknowledged.' };
const INVALID_LINK_PAGE = { icon: '⚠️', title: 'Link not valid', message: 'This acknowledgment link is invalid or has expired.' };
const ESCALATED_PAGE = { icon: '⏰', title: 'Window expired', message: 'Acknowledgment window expired. The SLA escalation has already started.' };
const SERVER_ERROR_PAGE = { icon: '⚠️', title: 'Something went wrong', message: "We couldn't record your acknowledgment right now. Please try again in a moment." };

type AckItem = {
  id: string;
  user_id: string;
  workflow_id: string;
  execution_id: string;
  node_id: string;
  node_name: string | null;
  deployment_version_id: string | null;
  status: string;
  mode: string | null;
  resume_attempts: number | null;
  acknowledgment_token_hash: string | null;
};

/**
 * Shared by GET and POST -- looks up the row and validates the supplied
 * token in constant time. Never distinguishes "row doesn't exist" from
 * "row exists but wrong token" (no existence leak, Part J), and never
 * echoes the token anywhere (not in a response, not in a log line).
 */
async function lookupAndValidateToken(
  db: ReturnType<typeof createServiceClient>,
  id: string,
  token: string | null
): Promise<{ ok: true; item: AckItem } | { ok: false }> {
  if (!token) return { ok: false };

  const { data: item } = await db
    .from('workflow_acknowledgments')
    .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts, acknowledgment_token_hash')
    .eq('id', id)
    .maybeSingle();

  if (!item || !item.acknowledgment_token_hash) return { ok: false };

  const suppliedHash = createHash('sha256').update(token).digest();
  const storedHash = Buffer.from(String(item.acknowledgment_token_hash), 'hex');
  const validToken = suppliedHash.length === storedHash.length && timingSafeEqual(suppliedHash, storedHash);
  if (!validToken) return { ok: false };

  return { ok: true, item: item as AckItem };
}

/**
 * GET /api/acknowledgments/[id]/ack?token=...
 *
 * READ-ONLY by construction (Incident 9.9.17I): performs zero writes of any
 * kind, on every branch, regardless of how many times it is called or by
 * what -- a human's browser, a link-scanning crawler, a prefetch, a HEAD-
 * like speculative fetch. It renders the current state and, only when the
 * item is genuinely still 'pending', a real <form method="POST"> the human
 * must submit themselves. No automated fetcher submits HTML forms.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const token = req.nextUrl.searchParams.get('token')?.trim() ?? null;
  const result = await lookupAndValidateToken(createServiceClient(), params.id, token);
  if (!result.ok) return htmlResponse(404, INVALID_LINK_PAGE);
  const { item } = result;

  if (item.status === 'acknowledged') {
    return htmlResponse(200, ALREADY_ACKNOWLEDGED_PAGE);
  }

  if (item.status === 'timed_out') {
    return htmlResponse(200, ESCALATED_PAGE);
  }

  // status === 'pending' -- the only branch that renders the human action.
  return htmlResponse(200, {
    icon: '🔥',
    title: 'Hot Lead',
    message: 'This lead is waiting for acknowledgment.',
    formAction: `/api/acknowledgments/${params.id}/ack`,
    formToken: token ?? '',
  });
}

/**
 * POST /api/acknowledgments/[id]/ack
 *
 * The ONLY path that may attempt the pending -> acknowledged CAS
 * (Incident 9.9.17I, Part 1). Reads the token from the submitted form body
 * (application/x-www-form-urlencoded), not the query string -- POST bodies
 * are not written to typical server/proxy access logs or browser history
 * the way a URL is, so this is a strict reduction in where the token can
 * leak, on top of it never being logged or persisted in plaintext anywhere
 * (unchanged from before).
 *
 * CSRF: this action has no ambient authority to ride -- there is no
 * cookie/session driving it, only possession of the high-entropy bearer
 * token submitted in the request itself. A cross-site page could only
 * forge this POST if it already knew the correct token, at which point it
 * is already a legitimate holder of the link and CSRF protection is moot.
 * Deliberately NOT adding a separate CSRF token/cookie check: doing so
 * would require a session to anchor it to, which is exactly the
 * cookie/session-based model this route must not adopt.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const form = await req.formData().catch(() => null);
  const token = (form?.get('token') ? String(form.get('token')) : req.nextUrl.searchParams.get('token'))?.trim() ?? null;

  const db = createServiceClient();
  const result = await lookupAndValidateToken(db, params.id, token);
  if (!result.ok) return htmlResponse(404, INVALID_LINK_PAGE);
  const { item } = result;

  if (item.status === 'acknowledged') {
    await attemptAcknowledgmentResume({ ...item, mode: (item.mode ?? 'live') as 'test' | 'live' });
    return htmlResponse(200, ALREADY_ACKNOWLEDGED_PAGE);
  }

  if (item.status === 'timed_out') {
    // Part H -- late acknowledgment via an explicit POST. Never rewinds `status`.
    const nowIso = new Date().toISOString();
    await db
      .from('workflow_acknowledgments')
      .update({ late_acknowledged_by: item.user_id, late_acknowledged_at: nowIso, updated_at: nowIso })
      .eq('id', params.id)
      .eq('status', 'timed_out')
      .is('late_acknowledged_at', null)
      .select('id')
      .maybeSingle();

    return htmlResponse(200, ESCALATED_PAGE);
  }

  const nowIso = new Date().toISOString();

  // The token is scoped to exactly this row's own tenant (item.user_id) --
  // a valid token can never acknowledge on behalf of a different tenant,
  // since it only ever validates against THIS row's own stored hash.
  const { data: updated, error: updateError } = await db
    .from('workflow_acknowledgments')
    .update({ status: 'acknowledged', acknowledged_by: item.user_id, acknowledged_at: nowIso, updated_at: nowIso })
    .eq('id', params.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (updateError) {
    return htmlResponse(500, SERVER_ERROR_PAGE);
  }

  if (!updated) {
    // Lost a race with a concurrent timeout/decide (Part E) -- re-read the
    // now-authoritative state rather than assuming which side won.
    const { data: latest } = await db
      .from('workflow_acknowledgments')
      .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts')
      .eq('id', params.id)
      .maybeSingle();
    if (!latest) return htmlResponse(404, INVALID_LINK_PAGE);

    if (latest.status === 'timed_out') {
      const lateNowIso = new Date().toISOString();
      await db
        .from('workflow_acknowledgments')
        .update({ late_acknowledged_by: latest.user_id, late_acknowledged_at: lateNowIso, updated_at: lateNowIso })
        .eq('id', params.id)
        .eq('status', 'timed_out')
        .is('late_acknowledged_at', null);
      return htmlResponse(200, ESCALATED_PAGE);
    }

    await attemptAcknowledgmentResume({ ...latest, mode: (latest.mode ?? 'live') as 'test' | 'live' });
    return htmlResponse(200, ALREADY_ACKNOWLEDGED_PAGE);
  }

  await attemptAcknowledgmentResume({
    id: item.id,
    user_id: item.user_id,
    workflow_id: item.workflow_id,
    execution_id: item.execution_id,
    node_id: item.node_id,
    node_name: item.node_name,
    deployment_version_id: item.deployment_version_id,
    mode: (item.mode ?? 'live') as 'test' | 'live',
    resume_attempts: item.resume_attempts,
  });

  return htmlResponse(200, ACKNOWLEDGED_PAGE);
}
