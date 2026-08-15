# Supabase Failure Chaos Report — Phase 21

**Date:** 2026-06-01  
**Scope:** All Supabase database access paths in `lib/runtime/`  
**Method:** Code analysis against migration files and runtime source

---

## Executive Summary

The runtime handles the four critical Supabase failure modes (outage, slow queries, pool exhaustion, constraint violations) without data corruption. Failures surface as structured log events and runtime events rather than silent drops. One gap identified: no explicit timeout is set on Supabase JS client queries, meaning a hung Supabase connection blocks a BullMQ worker slot for the full BullMQ job timeout (default 30s per BullMQ `lockDuration`).

---

## Failure Scenario Analysis

### Scenario 1: Total Database Outage

**What happens:**

1. BullMQ picks up a job and calls into `executeWorkerJob()` in `worker.ts`
2. The first DB call (`claimQueueJobLease`) returns `{ error: { message: 'connection refused' } }`  
3. `claimQueueJobLease` returns `false` — **job is not processed**
4. Worker throws `'Queue job lease already held by another worker'` — BullMQ retries
5. After `max_attempts` exhausted, `recordQueueDeadLetter` is called (also fails silently)
6. `emitRuntimeEvent` with `execution.failed` is called — also fails silently, but the event is not lost because it would have been logged before the throw

**Gap:** If the DB is down when `recordQueueDeadLetter` is called, the dead-letter record is not written. The failed job is still in the BullMQ failed set, so it is recoverable via `recoverStuckQueueJobs`.

**Recovery path:** `recoverStuckQueueJobs()` queries `runtime_queue_jobs WHERE status='active' AND heartbeat_at < cutoff`. This query also fails during total outage, but the self-heal cron invoked via `/api/runtime/self-heal` will retry when the DB comes back. No jobs are permanently lost.

**Verdict:** DEGRADED (no data corruption, jobs survive in BullMQ failed set, self-heal recovers on restoration)

---

### Scenario 2: Slow Query / Network Timeout

**Code path:** `renewExecutionOwnership` is called on a 15-second timer (`BASE_RENEW_MS = 15_000`) during job processing.

```typescript
void renewExecutionOwnership({ ... }).catch(() => undefined);
```

The `.catch(() => undefined)` on the renewal call means a slow renewal does not throw — it continues. The miss counter increments:

```typescript
renewMissCount += 1;
if (renewMissCount >= 3) {
  logger.warn('lease_renewal_lag', { execution_id, worker_id, miss_count });
}
```

After 3 misses (`45s + jitter`) without a successful renewal, the lease expires at the DB level (`lease_expires_at < now()`). A second worker attempting to claim the execution would see an expired lease and could steal it. This is the intended fencing-token split-brain prevention.

**Ownership validation** is called at each step inside `executeWorkerJob`. If a DB timeout causes `validateExecutionOwnership` to return `{ valid: false }`, processing halts immediately:

```typescript
const validationResult = await validateExecutionOwnership({ ... });
if (!validationResult.valid) {
  logger.warn('ownership_validation_failed', { ... });
  throw new BullUnrecoverableError('ownership validation failed');
}
```

**Verdict:** HANDLED (timeouts trigger lease expiry; ownership validation prevents split-brain; `BullUnrecoverableError` prevents infinite retry on stale ownership)

---

### Scenario 3: Connection Pool Exhaustion

The MagicFlux runtime uses the Supabase JS client (`@supabase/supabase-js`), which connects over HTTP/REST or WebSocket rather than maintaining a persistent PG connection pool. Each `createServiceClient()` call in a serverless function produces a new client with its own fetch-based connection. There is no client-side pool to exhaust.

At the Supabase infrastructure level, connection pooling is managed by PgBouncer on Supabase Pro. On the free tier, PgBouncer is not available and the 60-connection limit on the free Postgres instance applies. Under high load:

- Multiple concurrent workers each open a connection per query
- At 8 queues × 5 concurrency = 40 concurrent worker slots
- Each slot may hold an open transaction during `pg_advisory_xact_lock` (event sequence number assignment)
- 40 connections + monitoring/cron overhead approaches the free-tier limit

**Evidence from `lib/runtime/event-store.ts`:** The `appendExecutionEvent` function uses `pg_advisory_xact_lock` inside a transaction. If the connection limit is reached, new queries return `too many connections` from Supabase, which propagates as a Supabase JS error.

**Mitigations present:**
- `pg_advisory_xact_lock` transactions are short (single INSERT + lock release)
- `appendExecutionEvent` errors propagate upward and cause the BullMQ job to fail with retry

**Gap:** There is no circuit-breaker or connection-limit check. Under sustained pool exhaustion, all workers retry simultaneously, amplifying the problem (thundering herd on reconnect).

**Verdict:** AT RISK on free tier at full concurrency. Mitigated on Supabase Pro with PgBouncer.

**Recommendation:** Upgrade to Supabase Pro before scaling beyond 20 concurrent workers. This was flagged as a condition in Phase 20 production certification.

---

### Scenario 4: Upsert Constraint Violations (Cross-tenant conflicts)

**Code path:** `runtime_execution_controls`, `runtime_node_states`, `runtime_execution_snapshots`

Migration `20260523000001_runtime_multitenant_hardening.sql` added tenant-scoped unique indexes:
- `runtime_node_states(execution_id, node_id, user_id)`
- `runtime_execution_controls(execution_id, user_id)`
- `runtime_execution_snapshots(execution_id, snapshot_version, user_id)`

This prevents a cross-tenant overwrite where two users share an `execution_id` string. The upsert conflict resolution is now scoped: same user → update; different user with same execution_id → PK violation surfaced as an error.

**Verdict:** HANDLED (tenant-scoped conflict targets in place since Phase 7 hardening)

---

### Scenario 5: Event Table Delete Attempt

**Code path:** Any code calling `DELETE FROM runtime_execution_events`

Migration `20260601000001_runtime_event_immutability.sql` installs a `BEFORE DELETE` trigger:

```sql
CREATE TRIGGER tg_execution_events_no_delete
  BEFORE DELETE ON runtime_execution_events
  FOR EACH ROW EXECUTE FUNCTION prevent_execution_event_delete();
```

This trigger fires for ALL callers including the Supabase service role (which bypasses RLS but not triggers). Any attempt to delete events raises:

```
restrict_violation: runtime_execution_events is append-only. Deletion is forbidden.
```

The compaction flow correctly uses `UPDATE SET archivable = true` rather than DELETE. The immutability trigger allows this because it only checks identity/content columns, not `archivable`.

**Verdict:** HARDENED (DB-level trigger blocks all deletes regardless of caller role)

---

### Scenario 6: Incident Creation During DB Failure

**Code path:** `createIncident()` in `lib/runtime/incident-manager.ts`

Incidents are created by the alert evaluation loop when thresholds are breached. If the DB is unavailable during incident creation:
- The error is propagated upward from `db.from('runtime_incidents').insert(...)`
- No retry is performed in the incident manager itself
- The next alert evaluation cycle (typically every 60 seconds) will re-evaluate and attempt to create the incident again, but deduplication (`ON CONFLICT DO UPDATE`) prevents duplicate incidents

**Verdict:** HANDLED (next evaluation cycle recovers; deduplication prevents phantom duplicates)

---

## Summary Table

| Failure Mode | Behavior | Recovery |
|---|---|---|
| Total DB outage | Jobs fail with retry; dead-letter skipped | Self-heal recovers jobs on restoration |
| Slow query / timeout | Lease expiry triggers; ownership validation halts split brain | Automatic via lease TTL |
| Connection pool exhaustion | Queries fail with error; jobs retry | Supabase Pro PgBouncer required at scale |
| Cross-tenant upsert collision | PK violation surfaced as error; no silent overwrite | Tenant-scoped indexes in 20260523 |
| Event table delete | DB trigger raises `restrict_violation` | Blocked at DB level; not recoverable by caller |
| Incident creation failure | Silently skipped; next eval cycle retries | Deduplication prevents duplicates |

---

## Remaining Gaps

1. **No explicit query timeout on Supabase JS client** — a hung DB query blocks a worker slot indefinitely until BullMQ's job lock expires. Mitigate by setting `global.fetch` timeout or using Supabase's `AbortSignal` support.
2. **Dead-letter write failure is silent during total outage** — consider a secondary in-memory DLQ that flushes on reconnect.
3. **Connection pool limit on free tier** — 40 concurrent workers approach the 60-connection ceiling. Supabase Pro required for production.
