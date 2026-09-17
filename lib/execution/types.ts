// ─── Enums ────────────────────────────────────────────────────────────────────

export type ExecutionStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'waiting'
  | 'paused'
  | 'cancelled';

export type NodeStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'retrying'
  | 'cancelled'
  | 'skipped';

export type ExecutionMode = 'test' | 'live';

// ─── Core domain models ───────────────────────────────────────────────────────

export interface ExecutionStep {
  id: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  status: NodeStatus;
  attempt: number;
  input_data: Record<string, unknown> | null;
  output_data: Record<string, unknown> | null;
  logs: string[];
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  /** Earliest started_at for this node (used for timeline ordering) */
  min_started_at: string | null;
}

export interface ExecutionRecord {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  step_count: number;
  failed_step_count: number;
  error_message: string | null;
  retry_count: number;
  /**
   * Phase 9.9.14 -- Part B/M/N: the derived operational-state taxonomy
   * (lib/runtime/operational-state.ts), distinguishing e.g.
   * waiting_human/waiting_acknowledgment/configuration_blocked/
   * indeterminate/recovery_required from the raw 7-value DB status alone.
   * Optional so existing call sites that don't compute it (e.g. a
   * lightweight list view) remain valid without every caller needing an
   * update.
   */
  operational_state?: string;
  operational_state_reason?: string;
}

export interface ExecutionDetail extends ExecutionRecord {
  input_data: Record<string, unknown> | null;
  output_data: Record<string, unknown> | null;
  steps: ExecutionStep[];
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface ExecutionMetrics {
  total_executions: number;
  success_count: number;
  failed_count: number;
  running_count: number;
  success_rate: number;           // 0–100
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  last_execution_at: string | null;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface ExecutionFilter {
  workflow_id?: string;
  status?: ExecutionStatus | '';
  mode?: ExecutionMode | '';
  from?: string;      // ISO date string
  to?: string;        // ISO date string
  search?: string;    // free-text on workflow name
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedExecutions {
  executions: ExecutionRecord[];
  total: number;
  page: number;
  page_size: number;
  has_next: boolean;
}

// ─── API response envelopes ──────────────────────────────────────────────────

export interface ExecutionDetailResponse {
  execution: ExecutionDetail;
}

export interface ExecutionMetricsResponse {
  metrics: ExecutionMetrics;
  window_days: number;
}

// ─── UI state ────────────────────────────────────────────────────────────────

export type DrawerTab = 'input' | 'output' | 'logs' | 'raw';

export interface ExecutionStoreState {
  activeStep: ExecutionStep | null;
  activeTab: DrawerTab;
  drawerOpen: boolean;
  filters: ExecutionFilter;
  page: number;
}
