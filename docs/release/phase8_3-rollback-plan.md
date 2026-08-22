# Phase 8.3 — Rollback Plan

Reference stable point: tag `magicflux-phase8.1-stable` → commit `e53f28e`.
No destructive command below has been executed; this is a documented
procedure for the deploying operator to run manually if needed.

## A. Application rollback (web/API process)

Vercel (or equivalent) keeps prior deployments immutable and addressable.
Rollback is a platform-level pointer change, not a git operation:
1. In the deployment platform, select the previous known-good deployment
   (the one built from `magicflux-phase8.1-stable` or earlier) and promote
   it back to production traffic.
2. If deploying from git directly: `git checkout magicflux-phase8.1-stable`
   in a fresh checkout/CI job and redeploy from there — never `git reset
   --hard` on `main` itself, which would discard the tagged commits from
   the branch history other collaborators may already have pulled.
3. New webhook/lifecycle/dispatch routes (`/api/workflows/[id]/webhook`,
   `/api/workflows/[id]/lifecycle`, `/api/cron/dispatch-schedules`) are all
   additive relative to the prior architecture — rolling the app back does
   not orphan data, since every write they perform targets tables that
   also existed (with compatible or superset schemas) beforehand.

## B. Worker rollback

The worker (`scripts/runtime-worker.ts`, started via `RUNTIME_WORKER_ENABLED=true`)
is a separate deployable process from the web app:
1. Stop the worker process (or scale its deployment to 0).
2. Redeploy the worker from the rollback target commit.
3. Restart. In-flight BullMQ jobs already claimed by the old worker version
   will either complete (if the old process is allowed to drain first) or
   become unclaimed and be picked up by the new worker on restart — BullMQ
   jobs are durable in Redis independent of which worker version processes
   them, and `lib/runtime/worker.ts`'s ownership/lease mechanism (fencing
   tokens) prevents two workers from double-processing the same execution
   regardless of version skew.
4. **Web/worker version skew window:** if the web app is rolled back before
   the worker, jobs enqueued by the new (pre-rollback) web app's job shape
   are still consumable by the old worker as long as the `run_workflow_execution`
   task type and its payload shape (`executionId, workflowId, userId,
   deploymentVersionId, args.inputData, args.mode`) are unchanged — which
   they are, back through this same Phase 8.1 introduction. Rolling back
   past Phase 8.1 (into Phase 8, before this task type existed) would leave
   any already-queued `run_workflow_execution` jobs permanently unconsumed;
   in that specific case, drain the queue (let existing jobs fail/expire
   via BullMQ's job TTL, or manually inspect and discard them via BullMQ's
   admin UI/API) before rolling the worker back that far.

## C. Migration rollback / forward-fix strategy

No `DOWN` migrations exist in this repository (Supabase's migration model
is forward-only, matching every migration already in `supabase/migrations/`).
Rollback strategy is therefore **forward-fix, not reverse-apply**:
1. Never manually run `DROP TABLE`/`DROP COLUMN` against production to
   "undo" `20260610000001_phase8_1_production_hardening.sql` or
   `20260605000001_phase8_workflow_lifecycle_and_scheduler.sql` — both are
   purely additive (new tables, new nullable columns, widened CHECK
   constraints) and safe to leave in place even if the application code
   is rolled back to a pre-Phase-8 version; unused new columns/tables are
   inert, not breaking.
2. If a genuine schema defect is found, write a new, forward migration
   timestamped after `20260610000001` that corrects it — do not edit
   historical migration files (breaks replay for anyone who already
   applied them).
3. The one non-additive change worth calling out: the `workflow_executions_v2.status`
   CHECK constraint was widened (added `'queued'`) via a defensive
   DROP-then-ADD pattern. Rolling the *application* back below Phase 8.1
   while leaving this migration applied is safe — old code simply never
   writes `'queued'`, and the constraint still accepts every status older
   code used.

## D. Redis / queue recovery

1. **Redis instance lost entirely:** the app degrades gracefully —
   `canUseRuntimeRedis()` returns `false`, `enqueueRuntimeJob` returns
   `{enqueued:false}`, and the webhook route returns `503 ENQUEUE_FAILED`
   rather than hanging or crashing (see `lib/runtime/execution-dispatch.ts`).
   Provision a new Redis instance and point `REDIS_URL` at it; no queue
   state needs to be manually reconstructed because BullMQ's job data was
   never the source of truth for execution state (Postgres is).
2. **Redis reachable but queue is in a bad state** (e.g. poison jobs
   repeatedly failing): use BullMQ's own admin tooling (Bull Board, or
   `Queue.clean()`/`Queue.obliterate()` via a one-off script) to drain the
   `execution_queue`. Every job that was ever enqueued has a corresponding
   `workflow_executions_v2` row already created by
   `dispatchProductionExecution()` *before* enqueueing — so nothing about
   execution history is lost by clearing the queue; only in-flight/queued
   work is dropped, and those rows will need to be reconciled (see E).

## E. Stuck executions

An execution can only be left in a non-terminal state (`queued`/`running`)
by an infrastructure failure, never by application logic — every code path
that creates a `queued` row either transitions it to `running`→terminal, or
explicitly marks it `failed` on enqueue failure (`execution-dispatch.ts`),
worker resolve failure, or an uncaught exception in the worker's job
handler (`lib/runtime/worker.ts`'s catch block). Recovery for whatever
still gets stuck (e.g. a hard worker-process kill mid-job):
1. `lib/runtime/hardening-layer.ts`'s `recoverOrphanExecutions()` and
   `markOrphanExecutionsFailed()` already exist for exactly this — they run
   as part of the self-heal path (`lib/runtime/self-healer.ts`) and flip
   any execution whose ownership lease has expired or whose `updated_at`
   is stale back to `waiting`/`failed`.
2. Confirm the self-heal path is actually scheduled to run in the target
   environment — per the Phase 8 report, it currently relies on an
   external pinger, not a Vercel Cron entry in `vercel.json`. **Before
   relying on automatic stuck-execution recovery in production, either
   configure that external pinger or add a Vercel Cron entry calling it.**
3. Manual fallback: `UPDATE workflow_executions_v2 SET status='failed',
   error_message='Manually recovered — stuck execution' WHERE status IN
   ('queued','running') AND updated_at < now() - interval '1 hour'` — safe
   because it only targets executions already stale by an hour, and status
   transitions are terminal (never re-read by anything expecting `running`).

## F. Concurrency reservation cleanup

1. `reserve_concurrency_slot()` lazily reclaims expired reservations
   (`runtime_concurrency_reservations.expires_at < now()`) on every new
   reservation attempt for the same scope — no manual action needed in the
   common case.
2. `reclaimExpiredConcurrencyReservations()` (wired into the existing
   orphan-recovery sweep, `runtime/hardening-layer.ts`) proactively sweeps
   even scopes that see no new traffic. Same dependency as E.2 — confirm
   this sweep is actually scheduled in production.
3. Manual fallback if reservations appear stuck and blocking legitimate
   traffic: `UPDATE runtime_concurrency_reservations SET released_at = now()
   WHERE released_at IS NULL AND expires_at < now()` — this is exactly
   what `reclaim_expired_concurrency_reservations()` does; safe to run
   directly, idempotent, only affects rows already past their TTL.
