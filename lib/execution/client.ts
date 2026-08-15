import type {
  ExecutionFilter,
  ExecutionDetailResponse,
  ExecutionMetricsResponse,
  PaginatedExecutions,
} from './types';

const BASE = '/api/executions';

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

  const res = await fetch(`${BASE}${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load executions: ${res.status}`);
  return res.json() as Promise<PaginatedExecutions>;
}

// ── Execution detail ──────────────────────────────────────────────────────────

export async function fetchExecutionDetail(id: string): Promise<ExecutionDetailResponse> {
  const res = await fetch(`${BASE}/${id}`, { cache: 'no-store' });
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

export async function fetchExecutionMetrics(
  workflowId?: string,
  days = 30
): Promise<ExecutionMetricsResponse> {
  const qs = buildParams({ workflow_id: workflowId, days });
  const res = await fetch(`${BASE}/metrics${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load metrics: ${res.status}`);
  return res.json() as Promise<ExecutionMetricsResponse>;
}
