# MagicFlux Runtime — Observability Audit

**Phase 20 — Real World Validation**
Generated: 2026-05-30
Method: Static analysis of telemetry coverage, alert rules, metric definitions, and tracing

---

## 1. Logging Coverage

### 1.1 Server-side logging

Production logging is concentrated in the worker layer:

| File | Log Level | Events Logged |
|---|---|---|
| `lib/runtime/worker.ts` | console.log / console.error | Worker start, job pickup, job success, job failure, job crash, DLQ promotion, queue drain |
| `lib/runtime/queue.ts` | console.log / console.warn | Queue pause/resume, BullMQ connection events |
| `lib/runtime/redis.ts` | console.error | Redis connection failure |

**Coverage gaps:**

| Layer | Logged | Not Logged |
|---|---|---|
| API route errors | Partial (some return 500 silently) | Route-level errors not emitted to structured log |
| Alert delivery failures | ✗ | webhook/Slack/Telegram delivery errors go to `catch {}` |
| RBAC permission denials | ✗ | 403 responses not logged with user_id + permission |
| SSE client connect/disconnect | ✗ | No structured log for SSE session lifecycle |
| Cost recording failures | ✗ | `recordExecutionCost` errors silently swallowed |
| Metric write failures | ✗ | `recordMetric` insert errors not logged |

### 1.2 Structured vs. unstructured logging

All current logs use `console.log/error` — **no structured logging** (no JSON format, no correlation IDs in log lines). This means:
- Logs cannot be filtered by `execution_id`, `worker_id`, or `user_id` in Vercel/cloud log aggregators.
- Correlation between a request trace and its log lines is not possible.

**Recommendation for production observability:**
```typescript
// Replace ad-hoc console.log with a structured emitter:
function log(level: 'info' | 'warn' | 'error', event: string, ctx: Record<string, unknown>) {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...ctx }));
}
```
This can be adopted incrementally without changing behavior.

---

## 2. Alert Coverage

### 2.1 Default alert rules

Five default rules are seeded from migration `20260531000005`:

| Rule | Condition | Threshold | Window | Severity |
|---|---|---|---|---|
| High Command Backlog | `queue_overload` | 200 pending commands | 5 min | warning |
| Worker Crash Detected | `worker_crash` | 1 crash | 5 min | critical |
| Incident Explosion | `incident_explosion` | 10 incidents | 15 min | critical |
| Replay Integrity Breach | `replay_corruption` | 1 occurrence | 5 min | critical |
| SLA Violation | `sla_violation` | 1 occurrence | 10 min | warning |

All default rules are **inactive by default** (`is_active = false`). Operators must explicitly activate them via the dashboard.

**Recommendation:** Activate at minimum `Worker Crash Detected` and `Replay Integrity Breach` on production deployment — these are critical safety alerts that should fire immediately.

### 2.2 Alert condition types vs. actual detectors

The alert engine evaluates conditions against runtime state (`evaluateAlertRules()`). Coverage:

| Condition Type | Alert Engine Check | Data Source |
|---|---|---|
| `queue_overload` | ✓ pending command count | `runtime_execution_commands.status='pending'` |
| `worker_crash` | ✓ recent crashes in window | `runtime_incidents.incident_type='worker_crash_repeated'` |
| `incident_explosion` | ✓ incident count in window | `runtime_incidents` count by window |
| `replay_corruption` | ✓ integrity breach events | `runtime_incidents.incident_type='replay_integrity_failure'` |
| `sla_violation` | ✓ violation count in window | `runtime_sla_violations` count |

**Gap: no alert for**:
- `memory_pressure` — worker memory_mb is tracked but no alert condition
- `dead_letter_spike` — anomaly detector detects it but no alert rule condition type maps to it
- `execution_loop` — anomaly detector detects it but no alert condition
- `cost_overrun` — no budget threshold alert
- `redis_connection_failure` — Redis errors don't propagate to runtime_incidents

### 2.3 Anomaly detection coverage

`lib/runtime/anomaly-detector.ts` detects 6 anomaly types:

| Anomaly | Detection Logic | Alert Written |
|---|---|---|
| `repeated_node_failures` | ≥5 failed executions in window | ✓ `runtime_anomaly_alerts` |
| `retry_storm` | retry ratio ≥ 20% of total commands | ✓ |
| `dead_letter_spike` | ≥5 DLQ entries in window | ✓ |
| `execution_loop` | ≥100 steps for single execution | ✓ |
| `worker_crash_frequency` | ≥2 crashes in window | ✓ |
| `queue_congestion` | ≥10 pending in queue | ✓ |

Anomaly alerts are stored in `runtime_anomaly_alerts` but **are not connected to the alert rules engine**. They do not trigger webhook/Slack/Telegram delivery. This is a coverage gap.

**Recommendation:** Add a `anomaly_detected` condition type to alert rules that fires when any anomaly alert of a given severity is written.

---

## 3. Metrics Coverage

### 3.1 Tracked metrics

`lib/runtime/metrics-engine.ts` via `recordRuntimeMetricsSnapshot()` captures:

| Metric | Unit | Collection Frequency |
|---|---|---|
| `cpu_load` | percentage | Per metrics collection cycle |
| `memory_mb` | megabytes | Per metrics collection cycle |
| `queue_depth` | count | Per metrics collection cycle |
| `queue_throughput` | commands/min | Per metrics collection cycle |
| `command_latency_ms` | milliseconds | Per metrics collection cycle |
| `execution_latency_ms` | milliseconds | Per metrics collection cycle |
| `worker_utilization` | percentage | Per metrics collection cycle |
| `error_rate` | percentage | Per metrics collection cycle |
| `incident_rate` | count/window | Per metrics collection cycle |

### 3.2 Metric blind spots

| Missing Metric | Impact | Recommendation |
|---|---|---|
| `alert_firing_rate` | Cannot trend alert noise vs. signal | Add firing count per condition_type |
| `webhook_delivery_success_rate` | No visibility into delivery failures | Count success/fail in delivery functions |
| `replay_integrity_score` | No historical trend of replay health | Record from `replay-integrity.ts` |
| `cost_per_execution_avg` | No cost trend alerting | Derive from `runtime_cost_records` |
| `sla_violation_rate_by_type` | Aggregated only | Break down by `target_type` |
| `p95_execution_duration` | Only avg tracked | Percentile from recent traces |
| `dead_letter_queue_depth` | DLQ size not tracked | Count `status='dead_letter'` commands |

### 3.3 Metrics retention

`runtime_metrics` lacks a hard TTL enforcement at the database level. The migration comment notes pg_cron as optional. Without it, metrics accumulate indefinitely.

**Current worst case:** 8 metrics × 720 hours/month × 12 snapshots/hour = 69,120 rows/month/user. At 1,000 users: 69M rows/month.

**Recommended retention query (add to scheduled API route or pg_cron):**
```sql
DELETE FROM runtime_metrics WHERE recorded_at < now() - INTERVAL '30 days';
```

---

## 4. Distributed Tracing Coverage

### 4.1 Trace lifecycle

`lib/runtime/tracing.ts` provides:
- `startTrace()` — writes to `runtime_traces`, records `trace_id`, `correlation_id`, `root_agent`
- `finishTrace()` — updates `status`, `metadata`, `finished_at`
- Span-level tracking via `TraceContext` (traceId, spanId, parentSpanId, correlationId)

**Coverage:**

| Flow | Traced | Span Depth |
|---|---|---|
| Workflow execution | ✓ | Execution-level |
| Individual AI agent steps | Partial | No sub-spans per agent tool call |
| Command dispatch | ✗ | No span created for BullMQ job enqueue |
| Worker job processing | ✗ | No trace propagated into worker context |
| Webhook delivery | ✗ | Delivery function has no trace |
| Replay operations | ✓ | Via execution_events correlation_id |

### 4.2 Correlation ID propagation

`runtime_execution_events.correlation_id` enables cross-execution tracing for related operations. The `runtime_idempotency_keys` table links operation → execution_id.

**Gap:** The correlation_id from an HTTP request is not automatically propagated to:
- BullMQ job payloads (worker picks up job without original request correlation_id)
- Alert firings (no trace context in `runtime_alert_firings.payload`)
- Anomaly alerts

### 4.3 Observability of self-healing actions

`lib/runtime/self-healer.ts` records all auto-remediation actions in `runtime_healing_actions` with:
- `action_type`, `target`, `result`, `affected_count`
- Cooldown enforcement prevents action storms

This is good observability — every automated healing action is auditable.

---

## 5. Health Score Coverage

### 5.1 Health history

`lib/runtime/health-score-v2.ts` computes a composite health score from:
- Worker availability
- Queue depth
- Incident rate
- Error rate
- SLA compliance

History is stored in `runtime_health_history`. The dashboard can show health score trends.

### 5.2 Health score blind spots

| Blind Spot | Recommendation |
|---|---|
| Score does not include alert firing rate | Integrate `runtime_alert_firings` count |
| Score does not include Redis health | Add Redis ping to health computation |
| Score does not include cost budget adherence | Optional: add cost overrun penalty |

---

## 6. Operator Audit Trail

### 6.1 Audit log coverage

All operator actions via the control plane are recorded in `runtime_operator_actions` via `recordOperatorAction()`:

| Action | Recorded |
|---|---|
| Resolve incident | ✓ |
| Escalate incident | ✓ |
| Comment on incident | ✓ |
| Retry command | ✓ |
| Dead-letter command | ✓ |
| Cancel execution | ✓ |
| Cancel/replay via workers | ✓ |
| Assign/revoke RBAC role | ✗ (rbac route does not call recordOperatorAction) |
| Create/update alert rule | ✗ |
| Create/update SLA target | ✗ |

**Gap:** RBAC changes, alert rule changes, and SLA target changes are not audited in `runtime_operator_actions`. These are high-privilege actions that should be logged.

### 6.2 Audit log retention

`runtime_operator_actions` has no TTL. For compliance, consider:
```sql
-- Keep operator actions for 1 year
DELETE FROM runtime_operator_actions WHERE created_at < now() - INTERVAL '365 days';
```

---

## 7. Summary

| Category | Coverage | Gaps | Priority |
|---|---|---|---|
| Logging | Partial | No structured logs; API errors not emitted | P1 |
| Alert rules | Partial | Only 5 conditions; anomaly alerts not connected | P1 |
| Metrics | Good | 7 missing metrics (DLQ depth, delivery rate, etc.) | P2 |
| Distributed tracing | Partial | No spans in worker/command/delivery layers | P2 |
| Operator audit trail | Good | RBAC/alert/SLA changes not audited | P2 |
| Self-healing observability | ✓ Complete | All actions recorded | — |
| Health score | Good | Redis health not included | P3 |
| Metrics retention | ⚠ Risk | No TTL enforcement | P1 |

**Observability Score: 68/100**

The self-healing loop, incident tracking, and health history provide a strong foundation. The main gaps are: structured logging, connecting anomaly detection to the alerting delivery pipeline, and ensuring metrics TTL doesn't cause table bloat at scale.
