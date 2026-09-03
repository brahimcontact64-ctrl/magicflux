import type {
  ExecutionFilter,
  ExecutionDetailResponse,
  ExecutionMetricsResponse,
  PaginatedExecutions,
} from './types';

const BASE = '/api/executions';

// Phase 9.5 Step H: found live -- a relative fetch() from a Server
// Component in this Next.js runtime does NOT get resolved against the
// deployment's own origin the way it might in some setups; Node's
// underlying fetch (undici) throws "TypeError: Failed to parse URL from
// /api/executions/..." outright. This was masked until now by an
// unrelated auth-guard crash that always fired first (see the two
// executions page.tsx files) -- fixing that crash newly exposed this one.
// A browser's fetch() has no such problem (relative URLs resolve against
// the current page origin natively), so only the server-side case needs
// an absolute URL.
function resolveUrl(path: string): string {
  if (typeof window !== 'undefined') return path;
  const site = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  return `${site.replace(/\/$/, '')}${path}`;
}

function buildParams(obj: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ── Execution list ────────────────────────────────────────────────────────────

export async function fetchExecutions(
  filter: ExecutionFilter = {},
  page = 1,
  pageSize = 20
): Promise<PaginatedExecutions> {
  const qs = buildParams({
    workflow_id: filter.workflow_id,
    status:      filter.status,
    mode:        filter.mode,
    from:        filter.from,
    to:          filter.to,
    search:      filter.search,
    page,
    page_size:   pageSize,
  });

  const res = await fetch(resolveUrl(`${BASE}${qs}`), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load executions: ${res.status}`);
  return res.json() as Promise<PaginatedExecutions>;
}

// ── Execution detail ──────────────────────────────────────────────────────────

/**
 * Phase 9.5 Step H: `extraHeaders` exists for server-component callers only.
 * A relative fetch() made from a Server Component runs on the server, not
 * in the browser -- there's no cookie jar to auto-attach the visitor's
 * session, unlike a client component's fetch() (which does this
 * automatically for a same-origin request). Without forwarding the
 * incoming request's cookie header explicitly, this call is unauthenticated
 * against GET /api/executions/[id], which then genuinely 404s for lack of
 * ownership -- confirmed live: every server-rendered first paint of
 * /executions/[id] showed "Page not found" regardless of whether the
 * requesting user really owned the execution. Client-component callers
 * (ExecutionDetailView's own polling, RunDetails) omit this param and are
 * unaffected.
 */
export async function fetchExecutionDetail(id: string, extraHeaders?: HeadersInit): Promise<ExecutionDetailResponse> {
  const res = await fetch(resolveUrl(`${BASE}/${id}`), { cache: 'no-store', headers: extraHeaders });
  if (!res.ok) throw new Error(`Failed to load execution: ${res.status}`);
  return res.json() as Promise<ExecutionDetailResponse>;
}

// ── Retry ─────────────────────────────────────────────────────────────────────
// Re-runs a failed/cancelled/paused execution from its last known state via the
// existing pause/cancel/resume/rewind control endpoint.

export async function retryExecution(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`/api/workflows/executions/${id}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resume' }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to retry execution: ${res.status}`);
  }
  return res.json() as Promise<{ success: boolean }>;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

// See fetchExecutionDetail's comment -- extraHeaders is for server-component
// callers to forward the incoming request's cookie, since a server-side
// fetch() has no browser cookie jar to inherit one from automatically.
export async function fetchExecutionMetrics(
  workflowId?: string,
  days = 30,
  extraHeaders?: HeadersInit
): Promise<ExecutionMetricsResponse> {
  const qs = buildParams({ workflow_id: workflowId, days });
  const res = await fetch(resolveUrl(`${BASE}/metrics${qs}`), { cache: 'no-store', headers: extraHeaders });
  if (!res.ok) throw new Error(`Failed to load metrics: ${res.status}`);
  return res.json() as Promise<ExecutionMetricsResponse>;
}
