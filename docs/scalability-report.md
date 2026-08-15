# Enterprise Scalability Verification Report — Phase 21

**Date:** 2026-06-01  
**Scope:** All runtime tables, hot query paths, lock contention, index coverage

---

## Tier Summary

| Load Tier | Concurrent Users | Executions/hour | Verdict |
|---|---|---|---|
| Development | 1–10 | 100 | PASS |
| Startup | 100 | 5,000 | PASS |
| Growth | 1,000 | 50,000 | PASS WITH CONDITIONS |
| Enterprise | 10,000 | 500,000 | NOT CERTIFIED |

---

## Hot Tables and Query Paths

### `runtime_execution_events` (hottest table)

**Volume projection:** 10 events per execution × 50,000 exec/hour = 500,000 inserts/hour at 1K users. At 10K users: 5M inserts/hour = ~1,400 inserts/second.

**Hot path — replay:** `SELECT * FROM runtime_execution_events WHERE execution_id = $1 ORDER BY sequence_number ASC`

Index: `runtime_execution_events_exec_seq_idx ON (execution_id, sequence_number ASC)` — covers replay completely. No sequential scan.

**Hot path — append:** Calls `append_execution_event()` which acquires `pg_advisory_xact_lock(hashtext(p_execution_id))`. This serializes sequence-number assignment per execution. Lock is held for the duration of a single INSERT — typically microseconds. Cross-execution inserts are fully parallel; only concurrent inserts for the *same* execution serialize. At 1K users with typical execution parallelism, this is not a bottleneck.

**Lock contention risk at 10K:** If a single long-running execution generates thousands of events, the advisory lock for that execution_id can queue behind earlier events. With 5M inserts/hour, advisory lock queue depth could grow under hot-spot executions. This is the primary scaling limit for the event table.

**Retention:** Phase 21 retention migration marks events archivable after 90 days. Without retention, this table grows unboundedly. At 500K inserts/hour, 90-day retention caps the table at ~1.08B rows — within Postgres range but requires partitioning at that scale.

**Index gap — GIN on `payload` JSONB:** Not present. If operators query `WHERE payload @> '{"error": "timeout"}'`, a sequential scan occurs. At 1K+ users this becomes a performance issue. Add when ad-hoc payload filtering is required.

---

### `runtime_metrics` (second hottest)

**Volume:** Metrics snapshot runs every 5 minutes. At 10K users with per-user metrics, this could be millions of rows per day.

**Indexes present:**
- `(metric_name, recorded_at DESC)` — covers time-series queries
- `(recorded_at DESC)` — covers retention purge
- `(window, recorded_at DESC)` — covers window-filtered queries

**GIN index on `labels` JSONB:** Missing. Phase 20 performance report (P1) flagged this. Without it, `WHERE labels @> '{"worker_id": "w1"}'` requires a sequential scan. At 69M rows/month (10K user projection), this is a table scan of multi-million rows.

**Recommendation:** `CREATE INDEX CONCURRENTLY runtime_metrics_labels_gin ON runtime_metrics USING GIN (labels)` — add to next migration.

**Retention:** Phase 21 retention migration purges rows older than 30 days. This bounds the table to ~69M rows at 10K users, which is manageable with the existing B-tree indexes but benefits from the GIN index for label filtering.

---

### `runtime_queue_jobs`

**Volume:** One row per BullMQ job. Jobs complete in seconds to minutes; completed/failed jobs persist until manually pruned.

**Indexes present:**  
- Status-based queries used by `recoverStuckQueueJobs`: `WHERE status='active' AND heartbeat_at < cutoff`
- No explicit index on `(status, heartbeat_at)` — sequential scan on large tables

**Gap:** Missing composite index `(status, heartbeat_at)` for the recovery hot path. At 50K exec/hour with average job duration 10s, the active job set at any point is ~139 jobs — small enough that a sequential scan is acceptable up to 100K total rows. Above that, an index is needed.

---

### `runtime_workers`

**Volume:** One row per active worker; heartbeat updated every 30 seconds.

**Query:** `WHERE heartbeat_at > now() - INTERVAL '2 minutes'` (liveness check in health endpoint)

**Index:** Phase 20 flagged `runtime_workers.heartbeat_at` index as unverified. Checking migration `20260507180000_phase7_runtime_infra_hardening.sql`:

The `runtime_workers` table has `heartbeat_at timestamptz` but no explicit index on that column was found in the migration files. At typical worker counts (< 100), the sequential scan is trivial. At 1,000+ workers this warrants an index. Add `CREATE INDEX CONCURRENTLY runtime_workers_heartbeat_idx ON runtime_workers (heartbeat_at DESC)` in the next migration.

---

### `runtime_incidents`

**Hot query:** Alert evaluation loop runs `SELECT * FROM runtime_incidents WHERE status IN ('open', 'investigating') AND user_id = $1`

**Index:** `(user_id, status)` — present in Phase 18 migration. Covered.

**Deduplication:** `ON CONFLICT (metric_name, user_id) WHERE status IN ('open', 'investigating')` — partial unique index. Prevents duplicate open incidents per metric per user. Correct.

---

## N+1 Query Analysis

| Code Path | Pattern | Status |
|---|---|---|
| Alert evaluation | Single query fetches all open incidents per user per evaluation cycle | PASS |
| RBAC `getPermissions` | 2 sequential queries (assignments + permissions), not per-permission | PASS |
| `recoverStuckQueueJobs` | Single bulk query with `LIMIT` | PASS |
| Worker heartbeat | Single UPDATE by worker_id (PK) | PASS |
| Event replay | Single range query on (execution_id, seq) index | PASS |

No N+1 patterns found in hot paths.

---

## Lock Contention

| Mechanism | Scope | Risk |
|---|---|---|
| `pg_advisory_xact_lock(hashtext(execution_id))` | Per execution_id, transaction-scoped | Low at 1K users; monitor hot-spot executions at 10K |
| BullMQ SKIP LOCKED in `fetch_pending_execution_commands` | Per queue, row-level | Low — SKIP LOCKED prevents blocking |
| Upsert conflict resolution in `runtime_execution_controls` | Per (execution_id, user_id) | Low — upserts are idempotent |

---

## Missing Indexes (Actionable)

| Table | Column / Expression | Type | Impact |
|---|---|---|---|
| `runtime_metrics` | `labels` JSONB | GIN | Required for label-filtered queries at scale |
| `runtime_workers` | `heartbeat_at` | B-tree DESC | Needed at 1,000+ workers |
| `runtime_queue_jobs` | `(status, heartbeat_at)` | B-tree | Needed at 100K+ total job rows |

---

## Certification by Tier

### 100 Users — CERTIFIED
All hot-path queries use covering indexes. Advisory lock contention negligible. Free-tier Supabase connection limit (60) is sufficient. Metrics table well below retention threshold.

### 1,000 Users — CERTIFIED WITH CONDITIONS
Conditions:
1. Upgrade to Supabase Pro for PgBouncer (40 concurrent workers approach free-tier connection limit)
2. Add GIN index on `runtime_metrics.labels` before label-filtered dashboard queries
3. Enable pg_cron or configure the retention API route (`/api/runtime/control/retention`) on a daily schedule

### 10,000 Users — NOT CERTIFIED
Blockers:
1. `runtime_execution_events` requires range partitioning by `created_at` at 1B+ rows
2. GIN index on `runtime_metrics.labels` mandatory (sequential scan on 700M rows is unacceptable)
3. `pg_advisory_xact_lock` hot-spot risk under concentrated execution load
4. Supabase connection pool must be replaced with a dedicated Postgres server or PgBouncer in transaction mode
5. BullMQ must be distributed across multiple Redis Cluster nodes
