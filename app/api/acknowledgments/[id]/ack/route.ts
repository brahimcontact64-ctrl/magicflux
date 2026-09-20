import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { attemptAcknowledgmentResume } from '@/lib/runtime/acknowledgment-resume';

type Ctx = { params: { id: string } };

/**
 * Incident 9.9.17H -- this route is meant to be opened directly by a human
 * tapping a link inside an email/Slack message, often through an in-app
 * browser (Gmail's own WebView) or after Gmail/Google Safe Browsing's own
 * link-wrapping redirect -- never via fetch()/XHR from a page that could
 * read a JSON body and render it. A bare `NextResponse.json(...)` response
 * has no visual representation there; the observed symptom (a blank page,
 * with the address bar still showing google.com from the wrapper's own
 * redirect) is exactly what an unstyled, unrendered JSON body looks like in
 * that context -- confirmed by reading this file, not guessed from the
 * screenshot. Every branch below now renders a minimal, self-contained,
 * first-party HTML page instead. No business logic changed: same CAS
 * updates, same resume call, same status codes, same security checks --
 * only the response body/content-type.
 */
function htmlPage(opts: { title: string; message: string; icon: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  p { font-size: 15px; color: #a8a8b3; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${opts.icon}</div>
    <h1>${esc(opts.title)}</h1>
    <p>${esc(opts.message)}</p>
  </div>
</body>
</html>`;
}

function htmlResponse(status: number, opts: { title: string; message: string; icon: string }): NextResponse {
  return new NextResponse(htmlPage(opts), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const ACKNOWLEDGED_PAGE = { icon: '✅', title: 'Lead acknowledged', message: 'This lead has been acknowledged successfully. The workflow will continue automatically.' };
const INVALID_LINK_PAGE = { icon: '⚠️', title: 'Link not valid', message: 'This acknowledgment link is invalid or has expired.' };
const ESCALATED_PAGE = { icon: '⏰', title: 'Already escalated', message: "This lead's response window already ended and it was escalated. Your acknowledgment has been recorded for the record." };
const SERVER_ERROR_PAGE = { icon: '⚠️', title: 'Something went wrong', message: "We couldn't record your acknowledgment right now. Please try the link again in a moment." };

/**
 * GET /api/acknowledgments/[id]/ack?token=...
 *
 * The UNAUTHENTICATED, token-based acknowledgment link (Part D) -- meant
 * to be clicked directly from a reminder/escalation notification without
 * requiring a dashboard session. Authorization here is ENTIRELY the
 * token's own unguessability (Part J: "workflow/execution IDs alone are
 * insufficient authorization" -- knowing this row's `id` from the URL path
 * proves nothing on its own; only a correct token does).
 *
 * Security:
 *   - The token is never stored in plaintext (wait-for-acknowledgment.ts
 *     only ever persists its SHA-256 hash) -- compared here by hashing the
 *     supplied value and comparing digests in constant time
 *     (timingSafeEqual), never a plain `===` string compare, to avoid a
 *     timing side-channel on the hash bytes. Never echoed back in the
 *     response body either (Incident 9.9.17H).
 *   - A missing/malformed/wrong-length/incorrect token, or a row with no
 *     token configured at all, fails closed with the exact same 404 a
 *     nonexistent row would produce -- never distinguishes "row exists but
 *     wrong token" from "row doesn't exist" (no existence leak).
 *   - A replayed (already-used) token is idempotent, never an error (Part
 *     J) -- re-clicking an already-acknowledged link just confirms it.
 *   - No redirect is ever issued from this route (no Location header) --
 *     the confirmation is rendered directly, so there is no open-redirect
 *     surface here at all.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const token = req.nextUrl.searchParams.get('token')?.trim();
  if (!token) return htmlResponse(404, INVALID_LINK_PAGE);

  const db = createServiceClient();

  const { data: item } = await db
    .from('workflow_acknowledgments')
    .select('id, user_id, workflow_id, execution_id, node_id, node_name, deployment_version_id, status, mode, resume_attempts, acknowledgment_token_hash')
    .eq('id', params.id)
    .maybeSingle();

  if (!item || !item.acknowledgment_token_hash) {
    return htmlResponse(404, INVALID_LINK_PAGE);
  }

  const suppliedHash = createHash('sha256').update(token).digest();
  const storedHash = Buffer.from(String(item.acknowledgment_token_hash), 'hex');
  const validToken = suppliedHash.length === storedHash.length && timingSafeEqual(suppliedHash, storedHash);

  if (!validToken) {
    return htmlResponse(404, INVALID_LINK_PAGE);
  }

  if (item.status === 'acknowledged') {
    await attemptAcknowledgmentResume({ ...item, mode: (item.mode ?? 'live') as 'test' | 'live' });
    return htmlResponse(200, ACKNOWLEDGED_PAGE);
  }

  if (item.status === 'timed_out') {
    // Part H -- late acknowledgment via the link. Never rewinds `status`.
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
    // Lost a race with a concurrent timeout/decide (Part E).
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
    return htmlResponse(200, ACKNOWLEDGED_PAGE);
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
