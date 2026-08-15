# MagicFlux Runtime — Database Performance Report

**Phase 20 — Real World Validation**
Generated: 2026-05-30
Method: Static index/query analysis + EXPLAIN ANALYZE pattern audit

---

## 1. Index Coverage Analysis

### 1.1 runtime_execution_events (hot path — event sourcing)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `WHERE execution_id = ? ORDER BY sequence_number ASC` | `runtime_execution_events_exec_seq_idx (execution_id, sequence_number ASC)` | ✓ Index-only scan |
| `WHERE causation_id = ?` | `runtime_execution_events_causation_idx (causation_id) WHERE NOT NULL` | ✓ Partial index |
| `WHERE correlation_id = ?` | `runtime_execution_events_correlation_idx (correlation_id) WHERE NOT NULL` | ✓ Partial index |
| `WHERE user_id = ? ORDER BY created_at DESC` | `runtime_execution_events_user_created_idx (user_id, created_at DESC)` | ✓ Composite index |
| `WHERE event_type = ?` | *(none)* | ⚠ Sequential scan |
| `WHERE fencing_token = ?` | *(none)* | ⚠ Sequential scan |

**Recommendation:** If filtering by `event_type` at scale becomes common (e.g., `WHERE event_type = 'execution_started'`), add:
```sql
CREATE INDEX runtime_execution_events_type_idx
  ON runtime_execution_events (event_type, created_at DESC);
```

**N+1 Risk:** `append_execution_event()` acquires `pg_advisory_xact_lock(hashtext(execution_id))` per call. This serializes concurrent event inserts for the same execution — correct by design, but means burst insertions for a single execution are sequential. No N+1 issue for different executions.

---

### 1.2 runtime_incidents (incident dedup — control plane)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `WHERE status IN ('open','investigating') ORDER BY severity, last_seen_at DESC` | `runtime_incidents_status_idx (status, severity, last_seen_at DESC)` | ✓ Composite index |
| `WHERE execution_id = ?` | `runtime_incidents_execution_idx (execution_id) WHERE NOT NULL` | ✓ Partial index |
| `WHERE user_id = ?` | `runtime_incidents_user_idx (user_id) WHERE NOT NULL` | ✓ Partial index |
| `WHERE incident_type = ? AND status IN (...)` | Covered by `status_idx` — partial filter on status narrows first | ✓ Acceptable |
| Dedup key `(incident_type, COALESCE(execution_id::text,''), COALESCE(worker_id,'')) WHERE status IN (...)` | `runtime_incidents_dedup_idx` (partial unique) | ✓ Enforced by DB |

**Observation:** `open_or_bump_incident()` performs a `SELECT ... WHERE status IN ('open','investigating')` before the conditional UPDATE. This is a point lookup against the dedup index — fast for small incident tables. At 100K+ open incidents, add:
```sql
CREATE INDEX runtime_incidents_type_status_idx
  ON runtime_incidents (incident_type, status)
  WHERE status IN ('open', 'investigating');
```

---

### 1.3 runtime_metrics (time-series — highest insert volume)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `WHERE metric_name = ? ORDER BY recorded_at DESC` | `runtime_metrics_name_recorded_idx (metric_name, recorded_at DESC)` | ✓ Composite index |
| `WHERE recorded_at DESC` (recent metrics) | `runtime_metrics_recorded_at_idx (recorded_at DESC)` | ✓ |
| `WHERE window = ? ORDER BY recorded_at DESC` | `runtime_metrics_window_idx (window, recorded_at DESC)` | ✓ |
| `WHERE metric_name = ? AND recorded_at > ?` | `runtime_metrics_name_recorded_idx` | ✓ Range scan on composite |

**Growth concern:** At 8 metric types × 12 recordings/hour × 24h = 2,304 rows/day, 30-day retention = ~69,120 rows. At 1,000 users triggering metrics, this grows to **69M rows/month**. The auto-purge comment in migration 20260531000001 notes pg_cron if available — implement retention:

```sql
-- Recommended: add to pg_cron or call from a scheduled API route
DELETE FROM runtime_metrics WHERE recorded_at < now() - INTERVAL '30 days';
```

---

### 1.4 runtime_alert_firings (cooldown queries)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `.in('rule_id', [...]).order('fired_at', DESC).limit(N)` | `runtime_alert_firings_rule_idx (rule_id, fired_at DESC)` | ✓ |
| `ORDER BY fired_at DESC` (dashboard) | `runtime_alert_firings_fired_idx (fired_at DESC)` | ✓ |

**Cooldown query pattern** (in `getLastFiringTimes`):
```typescript
db.from('runtime_alert_firings')
  .select('rule_id, fired_at')
  .in('rule_id', ruleIds)         // IN list — uses rule_idx
  .order('fired_at', { ascending: false })
  .limit(ruleIds.length * 2)
```
This is an `IN (uuid, uuid, ...)` on `rule_id` — Postgres will use a bitmap index scan over `runtime_alert_firings_rule_idx`. For 5 default rules (small IN list), this is trivially fast. Scales well to 100+ rules.

---

### 1.5 runtime_cost_records (analytics)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `WHERE cost_type = ? ORDER BY period_start DESC` | `runtime_cost_records_type_idx` | ✓ |
| `WHERE workflow_id = ? ORDER BY period_start DESC` | `runtime_cost_records_workflow_idx` | ✓ |
| `WHERE user_id = ? ORDER BY period_start DESC` | `runtime_cost_records_user_idx` | ✓ |
| `WHERE period_start > ?` | `runtime_cost_records_period_idx` | ✓ |
| `SUM(total_cost_usd) GROUP BY workflow_id` | None dedicated | ⚠ Aggregate scan |

**Recommendation for aggregate cost queries at scale:**
```sql
CREATE INDEX runtime_cost_records_workflow_cost_idx
  ON runtime_cost_records (workflow_id, total_cost_usd)
  WHERE workflow_id IS NOT NULL;
```

---

### 1.6 runtime_sla_violations (SLA monitoring)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `WHERE target_type = ? ORDER BY recorded_at DESC` | `runtime_sla_violations_type_idx` | ✓ |
| `WHERE recorded_at > ?` | `runtime_sla_violations_recorded_idx` | ✓ |
| `WHERE execution_id = ?` | `runtime_sla_violations_execution_idx (WHERE NOT NULL)` | ✓ |

---

### 1.7 runtime_rbac (permission checks — hot path)

| Query Pattern | Index Used | Coverage |
|---|---|---|
| `WHERE user_id = ?` (assignments lookup) | `runtime_role_assignments_user_idx` | ✓ |
| JOIN `runtime_role_permissions ON role_id` | PK index on `runtime_role_permissions (role_id, permission_id)` | ✓ |
| `WHERE permission_name = ?` | PK UNIQUE on `runtime_permissions` | ✓ |

**RBAC query chain in `requirePermission()`:**
1. `SELECT role_id FROM runtime_role_assignments WHERE user_id = ?` — uses `user_idx`
2. `SELECT permission_id FROM runtime_role_permissions WHERE role_id IN (...)` — PK scan
3. `SELECT permission_name FROM runtime_permissions WHERE id IN (...)` — PK scan

All three are PK/index lookups. Total: 3 round trips. At scale, consider caching permission results in Redis (per user_id, TTL ~60s) to eliminate RBAC DB calls on every authenticated API request.

---

## 2. Sequential Scan Detection

### 2.1 Identified sequential scan risks

| Table | Column | Pattern | Risk |
|---|---|---|---|
| `runtime_execution_events` | `event_type` | `WHERE event_type = 'execution_started'` | Medium — not currently in hot path but used in seed scripts |
| `runtime_incidents` | `incident_type` | Range queries not covered by dedup index alone | Low — dedup index helps for partial coverage |
| `runtime_cost_records` | `total_cost_usd` | `SUM(total_cost_usd)` aggregate without predicate | Medium — full table scan at high volume |
| `runtime_metrics` | `labels` JSONB | `WHERE labels @> '{"key":"val"}'` | High — JSONB containment has no GIN index |

### 2.2 Missing GIN index on JSONB labels

The `runtime_metrics.labels` column stores per-metric tag data (e.g., `{ "worker_id": "w1" }`). Filtering by label content requires a sequential scan.

**Recommended:**
```sql
CREATE INDEX runtime_metrics_labels_gin_idx
  ON runtime_metrics USING GIN (labels);
```

Similarly for `runtime_incidents.details` and `runtime_execution_events.payload` if label-based filtering is added to the dashboard.

---

## 3. Expensive Query Patterns

### 3.1 `computeRuntimeMetrics()` — multi-table aggregate

Located in `lib/runtime/metrics.ts`. Called by `recordRuntimeMetricsSnapshot()` on every metrics collection cycle. Pattern:

```typescript
// Parallel: workers, pending commands, active incidents, recent traces
Promise.all([
  db.from('runtime_workers').select(...).gte('heartbeat_at', cutoff),
  db.from('runtime_commands').select('id').eq('status','pending'),
  db.from('runtime_incidents').select('id').in('status', ['open','investigating']),
  db.from('runtime_traces').select(...).gte('started_at', windowStart)
])
```

All four sub-queries run in parallel — good. Each is covered by an index. Risk is at high row counts when `.gte('heartbeat_at', cutoff)` and `.gte('started_at', windowStart)` scan large ranges. Ensure `runtime_workers` has an index on `heartbeat_at`:

```sql
-- Verify this exists (added in phase7 hardening):
CREATE INDEX IF NOT EXISTS runtime_workers_heartbeat_idx
  ON runtime_workers (heartbeat_at DESC);
```

### 3.2 `getLastFiringTimes()` — alert cooldown

Called once per `evaluateAlertRules()` cycle. Performs a single `.in()` query against `runtime_alert_firings_rule_idx`. At 100 active rules with thousands of past firings, the index range scan returns only the most recent 2N rows. Fast in practice.

### 3.3 Runtime analytics dashboard — date-range aggregates

The `/api/runtime/analytics` route performs COUNT aggregates over `runtime_traces`, `runtime_incidents`, `runtime_cost_records` over rolling windows (24h, 7d, 30d). These hit:
- `runtime_metrics_name_recorded_idx` for metric history
- `runtime_incidents_status_idx` for incident counts
- `runtime_cost_records_period_idx` for cost aggregates

All covered by indexes. For the 30-day window at 10K+ rows, consider materialized views if query latency exceeds 500ms.

---

## 4. N+1 Query Detection

### 4.1 Alert evaluation loop — ✓ No N+1

`evaluateAlertRules()` batches all rule lookups:
```typescript
// Batch 1: fetch all active rules (single query)
const { data: activeRules } = await db.from('runtime_alert_rules').select('*').eq('is_active', true)

// Batch 2: fetch last firing times for all rule IDs at once (single .in() query)
const lastFired = await getLastFiringTimes(db, activeRules.map(r => r.id))

// Loop iterates in memory — no per-rule DB calls
for (const rule of activeRules) { ... }
```

No N+1. Each iteration uses pre-fetched data.

### 4.2 RBAC permission check — ✓ No N+1

`requirePermission()` performs exactly 3 sequential queries regardless of the number of roles assigned to a user. No loop-per-role pattern.

### 4.3 Seed script — ⚠ Potential N+1

`scripts/seed-large-dataset.ts` inserts in batches of 500 rows using `Promise.all` across batch groups. Within each batch group, inserts are parallel. This is correct — no N+1 in batch mode.

However, if run with `DRY_RUN=false` against a large existing dataset, the `ON CONFLICT DO NOTHING` paths can cause high lock contention on unique indexes. Acceptable for a one-time seed but should not be used as a recurring migration path.

---

## 5. Missing Index Recommendations (Priority Order)

| Priority | Table | Index | Rationale |
|---|---|---|---|
| P1 | `runtime_metrics` | `GIN (labels)` | Enables efficient JSONB label filtering |
| P1 | `runtime_workers` | `(heartbeat_at DESC)` | Core liveness query — verify exists from phase7 |
| P2 | `runtime_execution_events` | `(event_type, created_at DESC)` | Replay type filtering at scale |
| P2 | `runtime_incidents` | `(incident_type, status) WHERE status IN ('open','investigating')` | High-volume dedup scan |
| P3 | `runtime_cost_records` | `(workflow_id, total_cost_usd)` | Aggregate cost queries |
| P3 | `runtime_traces` | `(status, started_at DESC)` | Dashboard status filter at scale |

---

## 6. Storage Growth Projections

| Table | Rows/Day (100 users) | Rows/Day (10K users) | 30-Day Size @ 10K users |
|---|---|---|---|
| runtime_metrics | ~2,304 | ~230,400 | ~6.9M rows |
| runtime_execution_events | ~1,000 | ~100,000 | ~3M rows |
| runtime_traces | ~500 | ~50,000 | ~1.5M rows |
| runtime_cost_records | ~2,000 | ~200,000 | ~6M rows |
| runtime_incidents | ~50 | ~5,000 | ~150K rows |
| runtime_alert_firings | ~20 | ~2,000 | ~60K rows |

**Action required for 10K users:** Implement row-level TTL for metrics (30d), execution events (90d), and cost records (365d) via pg_cron or scheduled API routes before scaling beyond 1,000 users.

---

## 7. Connection Pool Configuration

MagicFlux uses Supabase's built-in connection pooler (PgBouncer in transaction mode). Relevant limits:

- **Transaction mode**: each API call gets a connection from the pool for the duration of the request. Compatible with PostgREST.
- **Default pool size**: 15 connections (free tier), 200+ (Pro tier).
- **Recommendation**: For 500+ concurrent API users, upgrade to Supabase Pro and configure `max_connections = 200` in PgBouncer settings.
- **Risk**: The `pg_advisory_xact_lock` in `append_execution_event()` holds a transaction-scoped lock. In transaction mode PgBouncer, this is safe as the lock is released when the transaction ends (before the connection is returned to the pool).

---

## 8. Summary

| Category | Status | Notes |
|---|---|---|
| Core hot-path indexes | ✓ Complete | Event sourcing, incidents, metrics, alerts |
| JSONB GIN indexes | ⚠ Missing | `runtime_metrics.labels` needs GIN |
| Sequential scan risks | ⚠ 4 identified | event_type, JSONB labels, cost aggregates |
| N+1 patterns | ✓ None found | All hot paths batch queries |
| Storage growth plan | ⚠ Action needed at 10K users | TTL purge needed for metrics/events |
| Connection pooling | ✓ PgBouncer compatible | Upgrade to Pro for 500+ users |
