// Shared types for the Runtime Operator Control Dashboard.
// These mirror the shapes returned by /api/runtime/control/* endpoints.

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus   = 'open' | 'investigating' | 'resolved';

export type Incident = {
  id:              string;
  incidentType:    string;
  severity:        IncidentSeverity;
  status:          IncidentStatus;
  executionId:     string | null;
  workflowId:      string | null;
  workerId:        string | null;
  userId:          string | null;
  title:           string;
  description:     string;
  occurrenceCount: number;
  firstSeenAt:     string;
  lastSeenAt:      string;
  resolvedAt:      string | null;
  resolvedBy:      string | null;
  details:         Record<string, unknown>;
};

export type HealthScoreComponents = {
  workerLiveness:        number;
  queueHealth:           number;
  commandBusHealth:      number;
  replayIntegrityHealth: number;
  incidentSeverityScore: number;
};

export type HealthScoreSignals = {
  commandBacklog:        number;
  deadLetterRate:        number;
  replayIntegrityStatus: 'clean' | 'degraded' | 'unknown';
  workerLivenessPercent: number;
  openIncidentCount:     number;
  criticalIncidentCount: number;
  queueDelay:            number;
};

export type HealthScoreV2 = {
  overallScore: number;
  components:   HealthScoreComponents;
  signals:      HealthScoreSignals;
  computedAt:   string;
};

export type WorkerSummary = {
  liveWorkers:    number;
  statuses:       Record<string, number>;
  totalConcurrency: number;
};

export type CommandBacklog = {
  byType:       Record<string, number>;
  statusCounts: Record<string, number>;
};

export type OverviewResponse = {
  healthScore:     HealthScoreV2;
  activeIncidents: Incident[];
  workerSummary:   WorkerSummary;
  commandBacklog:  CommandBacklog;
  recentActivity:  RecentAction[];
  generatedAt:     string;
};

export type RecentAction = {
  action_type:  string;
  operator_id:  string;
  execution_id: string | null;
  payload:      Record<string, unknown>;
  result:       Record<string, unknown>;
  created_at:   string;
};

export type ExecutionCommand = {
  id:                   string;
  execution_id:         string;
  workflow_id:          string | null;
  command_type:         string;
  command_version:      number;
  sequence_number:      number;
  status:               string;
  retry_count:          number;
  scheduled_for:        string | null;
  causation_id:         string | null;
  processing_started_at: string | null;
  acknowledged_at:      string | null;
  worker_id:            string | null;
  payload:              Record<string, unknown>;
  metadata:             Record<string, unknown>;
  created_at:           string;
};

export type Worker = {
  worker_id:      string;
  hostname:       string | null;
  pid:            number | null;
  status:         string;
  queues:         string[];
  capabilities:   string[];
  concurrency:    number;
  cpu_load:       number | null;
  memory_mb:      number | null;
  jobs_processed: number;
  restart_count:  number;
  heartbeat_at:   string;
  last_error:     string | null;
  updated_at:     string;
};

export type RestartRequest = {
  id:             string;
  worker_id:      string;
  reason:         string;
  requested_by:   string;
  status:         string;
  created_at:     string;
  acknowledged_at: string | null;
};

export type Execution = {
  id:            string;
  workflow_id:   string;
  user_id:       string;
  status:        string;
  started_at:    string | null;
  completed_at:  string | null;
  retry_count:   number;
  error_message: string | null;
  created_at:    string;
};

// ── Phase 17 additions ────────────────────────────────────────────────────────

export type IncidentEvent = {
  id:         string;
  incidentId: string;
  eventType:  'created' | 'updated' | 'escalated' | 'resolved' | 'comment';
  actor:      string;
  payload:    Record<string, unknown>;
  createdAt:  string;
};

export type OperatorAction = {
  id:           string;
  action_type:  string;
  operator_id:  string;
  execution_id: string | null;
  worker_id:    string | null;
  incident_id:  string | null;
  workflow_id:  string | null;
  payload:      Record<string, unknown>;
  result:       Record<string, unknown>;
  created_at:   string;
};

export type OperatorActionsResponse = {
  actions:  OperatorAction[];
  count:    number;
  total:    number;
  page:     number;
  pageSize: number;
};

export type HealthSnapshot = {
  id:            string;
  overall_score: number;
  components:    HealthScoreComponents;
  signals:       HealthScoreSignals;
  computed_at:   string;
};

export type HealthHistoryResponse = {
  snapshots: HealthSnapshot[];
  window:    '24h' | '7d' | '30d';
};

export type ExecutionEventRow = {
  id:              string;
  execution_id:    string;
  workflow_id:     string | null;
  user_id:         string;
  worker_id:       string | null;
  event_type:      string;
  event_version:   number;
  sequence_number: number;
  causation_id:    string | null;
  payload:         Record<string, unknown>;
  metadata:        Record<string, unknown>;
  created_at:      string;
};

export type ExecutionSnapshotRow = {
  id:               string;
  execution_id:     string;
  workflow_id:      string | null;
  snapshot_type:    string;
  snapshot_version: number;
  current_node_id:  string | null;
  state_snapshot:   Record<string, unknown>;
  created_at:       string;
};

export type ExecutionDetail = {
  execution: Execution;
  events:    ExecutionEventRow[];
  snapshots: ExecutionSnapshotRow[];
  commands:  ExecutionCommand[];
  incidents: Incident[];
};

export type WorkerDetail = {
  worker:          Worker;
  restartHistory:  RestartRequest[];
  activeIncidents: Incident[];
  recentCommands:  ExecutionCommand[];
};

// ── Phase 18 additions ────────────────────────────────────────────────────────

export type MetricWindow = '5m' | '15m' | '1h' | '24h' | '7d' | '30d';

export type MetricPoint = {
  recorded_at:  string;
  metric_value: number;
  labels:       Record<string, unknown>;
};

export type MetricSeries = {
  metric_name: string;
  window:      MetricWindow;
  points:      MetricPoint[];
};

export type MetricSnapshot = {
  cpu_load:             number;
  memory_mb:            number | null;
  queue_depth:          number;
  queue_throughput:     number;
  command_latency_ms:   number;
  execution_latency_ms: number;
  worker_utilization:   number;
  error_rate:           number;
  incident_rate:        number;
  recorded_at:          string;
};

export type MetricsResponse = {
  series:      MetricSeries;
  generatedAt: string;
};

export type MetricsSnapshotResponse = {
  snapshot:    MetricSnapshot;
  generatedAt: string;
};

export type Trace = {
  trace_id:       string;
  user_id:        string;
  session_id:     string | null;
  workflow_id:    string | null;
  execution_id:   string | null;
  correlation_id: string;
  root_agent:     string | null;
  status:         'running' | 'completed' | 'failed' | 'cancelled';
  started_at:     string;
  completed_at:   string | null;
  metadata:       Record<string, unknown>;
};

export type TraceSpan = {
  span_id:        string;
  trace_id:       string;
  parent_span_id: string | null;
  name:           string;
  kind:           string;
  agent_id:       string | null;
  queue_name:     string | null;
  job_id:         string | null;
  status:         'running' | 'success' | 'error' | 'cancelled';
  started_at:     string;
  ended_at:       string | null;
  duration_ms:    number | null;
  error_message:  string | null;
  attributes:     Record<string, unknown>;
};

export type TracesResponse = {
  traces:      Trace[];
  count:       number;
  generatedAt: string;
};

export type TraceDetailResponse = {
  trace: Trace;
  spans: TraceSpan[];
};

export type SlaTarget = {
  id:           string;
  target_type:  string;
  threshold_ms: number;
  warning_pct:  number;
  description:  string | null;
  is_active:    boolean;
  created_at:   string;
};

export type SlaViolation = {
  id:              string;
  target_id:       string | null;
  target_type:     string;
  severity:        'warning' | 'violated';
  actual_value_ms: number;
  threshold_ms:    number;
  execution_id:    string | null;
  worker_id:       string | null;
  command_id:      string | null;
  details:         Record<string, unknown>;
  recorded_at:     string;
};

export type SlaComplianceEntry = {
  total:         number;
  violated:      number;
  compliancePct: number;
};

export type SlaReport = {
  targets:          SlaTarget[];
  recentViolations: SlaViolation[];
  complianceByType: Record<string, SlaComplianceEntry>;
  windowHours:      number;
  generatedAt:      string;
};

export type CostSummary = {
  totalUsd:          number;
  byType:            Record<string, number>;
  byWorkflow:        Array<{ workflow_id: string; total_usd: number; execution_count: number }>;
  monthlyProjection: number;
  windowDays:        number;
};

export type CostResponse = {
  summary:      CostSummary;
  topWorkflows: Array<{ workflow_id: string; total_usd: number; execution_count: number }>;
  generatedAt:  string;
};

export type AlertChannel = 'dashboard' | 'email' | 'webhook' | 'slack' | 'telegram';

export type AlertChannelConfig = {
  email?:              string;
  webhook_url?:        string;
  slack_webhook?:      string;
  telegram_bot_token?: string;
  telegram_chat_id?:   string;
};

export type AlertRule = {
  id:             string;
  name:           string;
  condition_type: string;
  threshold:      number;
  window_minutes: number;
  severity:       string;
  channels:       AlertChannel[];
  channel_config: AlertChannelConfig;
  is_active:      boolean;
  created_by:     string | null;
  created_at:     string;
  updated_at:     string;
};

export type AlertFiring = {
  id:            string;
  rule_id:       string;
  fired_at:      string;
  resolved_at:   string | null;
  payload:       Record<string, unknown>;
  channels_sent: AlertChannel[];
};

export type AlertRulesResponse = {
  rules:       AlertRule[];
  count:       number;
  generatedAt: string;
};

export type AlertFiringsResponse = {
  firings:     AlertFiring[];
  count:       number;
  generatedAt: string;
};

export type RuntimeRole = {
  id:          string;
  name:        string;
  description: string | null;
  created_at:  string;
};

export type RoleAssignment = {
  id:         string;
  user_id:    string;
  role_id:    string;
  granted_by: string | null;
  created_at: string;
  role:       RuntimeRole;
};

export type RbacResponse = {
  roles:       RuntimeRole[];
  permissions: string[];
  userId:      string;
};

export type ReplayCheckpoint = {
  snapshotVersion: number;
  snapshotType:    string;
  currentNodeId:   string | null;
  createdAt:       string;
  eventCount:      number;
  eventTypes:      string[];
};

export type ReplayResponse = {
  execution:   Execution;
  events:      ExecutionEventRow[];
  snapshots:   ExecutionSnapshotRow[];
  commands:    ExecutionCommand[];
  checkpoints: ReplayCheckpoint[];
  incidents:   Incident[];
  generatedAt: string;
};
