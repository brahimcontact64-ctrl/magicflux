# Phase 8.8 — Execution Retry Recovery & Final Core Runtime Certification

Date: 2026-08-22
Starting branch/HEAD: `main` @ `b05d9ffae9562dbd5d079432b03068fb54dfe75b` (tag `magicflux-phase8-certified`)
Baseline: Phase 8.7 certified `PRODUCTION READY — EXTERNAL PROVIDERS PARTIALLY UNVERIFIED`.

## The gap

`runtime/workflow-engine.ts` can move an execution into `status='waiting'` with
a `next_run_at` after an execution-level retry is scheduled (a node
exhausted its own internal retry budget, but the execution's own
`retry_count` hadn't hit `max_retries` yet) — or after an intentional Wait
node pause. A full-codebase search for any query matching
`status='waiting' AND next_run_at <= now()` returned zero matches: nothing
anywhere consumed these rows. An execution in this state could remain stuck
indefinitely.

## Investigation (Step 0), before any code changed

1. **`retry_count` increment**: `runtime/workflow-engine.ts:591`,
   `nextRetry = retryCount + 1`, written via `RuntimeStateStore.setExecutionState()`.
2. **`next_run_at` write**: same call site (execution-level retry,
   exponential-ish backoff capped at 15 minutes) — plus a second, distinct
   source: a node handler (currently only the Wait node,
   `lib/workflow-runtime/node-handlers/wait.ts`) intentionally returning
   `status:'waiting'` with its own `nextRunAt`, `retryCount` unchanged.
3. **Statuses entering waiting**: both of the above funnel into the same
   `status='waiting'`/`next_run_at` columns on `workflow_executions_v2`.
4. **No consumer existed** — confirmed by search.
5. **Frozen version preservation**: `deployment_version_id` is set once at
   dispatch and never changes; resuming must re-fetch
   `deployment_versions.workflow_data` by that ID (falling back to
   `workflows.workflow_json` only if null) — the exact pattern already used
   identically by `lib/runtime/worker.ts`'s fresh-start handler and the
   manual pause/resume control route.
6. **Concurrency reservations during retry**: a genuine, confirmed bug —
   see below.
7. **Idempotency during retry**: not the webhook/schedule dispatch-level
   system (`reserveIdempotencyKey`/`runtime_execution_locks`, for *new*
   trigger events) — retry-dispatch's own idempotency is BullMQ-jobId-level,
   deterministic per `(executionId, retryCount)`.
8. **Self-heal overlap**: `markOrphanExecutionsFailed` only ever targets
   `status='running'` rows past a 10-minute staleness window — it has never
   touched `'waiting'` rows and does not need to; the new dispatcher's own
   claim marker (`'waiting'` → `'running'`) is already covered by this
   existing safety net if the dispatcher itself crashes mid-claim.

### Bug found before writing any new code: `reserve_concurrency_slot()` re-reservation

`runtime_concurrency_reservations.execution_id` is a PRIMARY KEY. The
original RPC ended with
`INSERT ... ON CONFLICT (execution_id) DO NOTHING; RETURN {reserved: true}`.
Every execution had previously been reserved at most once in its lifetime
(one dispatch, released once the worker's job settled) — Phase 8.8
introduces the first scenario where the *same* `execution_id` is
legitimately reserved a second time (resuming a `'waiting'` execution). On
that second call the row already existed (`released_at` set from the first
release), so the `INSERT` silently no-opped — yet the function still
returned `{reserved: true}` unconditionally. The stale row's `released_at`
was never cleared, so the "reservation" was invisible to the function's own
`COUNT(*) ... WHERE released_at IS NULL` limit checks: **every retried
execution's concurrency slot would have silently never counted against
anyone's limit.** Fixed via a new migration
(`20260611000001_phase8_8_concurrency_reservation_reclaim.sql`,
`CREATE OR REPLACE FUNCTION`) that allows the `INSERT`'s conflict to reclaim
the row only when it was genuinely previously released
(`ON CONFLICT (execution_id) DO UPDATE ... WHERE released_at IS NOT NULL`),
leaving a still-actively-held row (a real double-booking attempt) correctly
refused.

## Architecture

A scheduled retry dispatcher (`lib/runtime/retry-dispatcher.ts`,
`dispatchDueRetries()`) that:

- Queries `workflow_executions_v2` for `status='waiting' AND next_run_at <= now()`.
- Atomically claims each candidate via the exact optimistic-CAS
  `UPDATE ... WHERE status='waiting' AND next_run_at = <value just read>`
  pattern already proven by `lib/runtime/scheduler.ts`'s `pollDueSchedules()`
  (Phase 8.6 certified this pattern against real concurrent pollers) — no
  new atomicity mechanism invented. Claims *into* `status='running'`, not a
  new state-machine value, so a dispatcher crash between claim and enqueue
  is covered by the *existing* self-heal orphan sweep, not a new one.
- Reserves a concurrency slot (`reserveConcurrencySlot()`, the fixed RPC
  above) before enqueueing, mirroring `dispatchProductionExecution()`'s own
  pattern. If the user/workflow is at their limit, the claim is reverted
  back to `'waiting'` with the same `next_run_at` — concurrency pressure,
  not a failure; a later cron tick retries once a slot frees.
- Dispatches through the **existing** production queue/worker
  (`lib/runtime/queue.ts`'s `enqueueRuntimeJob`, new task type
  `'resume_workflow_execution'` handled in `lib/runtime/worker.ts`) — never
  calls the execution engine inline, never creates a duplicate execution
  row, never re-derives `workflow_json` itself (the worker re-resolves it
  from `deployment_version_id`, identically to every other queue-driven
  execution path).
- The BullMQ job's dedupe key is `resume:{executionId}:{retryCount}` —
  deterministic per execution *and* per retry attempt, so a duplicate cron
  invocation within the same attempt cannot enqueue a second job, while a
  later retry attempt (reachable only after this one settles) still gets
  its own job.
- Every enqueue attempt is raced against a bounded timeout
  (`RUNTIME_RETRY_DISPATCH_ENQUEUE_TIMEOUT_MS`, default 10s) — a genuine
  Redis outage makes `enqueueRuntimeJob()` *hang* rather than reject
  (ioredis's `maxRetriesPerRequest: null`), confirmed live; without a
  bound, a hung enqueue would leave the execution permanently claimed with
  the cron request itself stuck.

No new runtime engine: the worker's new `'resume_workflow_execution'` branch
calls a new `resumeWorkflowExecution()` export
(`lib/workflow-runtime/engine.ts`) that thinly wraps the *existing*
`ExecutionManager.resumeExecution()` — the same function the manual
pause/resume control route has always used, which fetches the persisted
checkpoint (`currentNodeId`, `pendingQueue`) and continues the *same*
`WorkflowEngine.execute()` from where it left off, rather than restarting
from the trigger node(s) the way a fresh dispatch does.

## Live certification (disposable Postgres 17 + PostgREST + Redis, real BullMQ)

All scenarios run against real infrastructure, zero mocks, using real
node-level retry exhaustion (a controlled local HTTP test server) to
produce genuine `'waiting'` executions with real engine-persisted
checkpoints — not hand-constructed fixtures — except where noted.

- **Atomic claim**: 10 concurrent `dispatchDueRetries()` calls against the
  same due execution → exactly 1 claim, exactly 1 enqueue, every time.
- **Frozen version preservation**: activated version A, forced execution A
  into real `'waiting'`, edited + activated version B, let the dispatcher
  resume execution A — it ran version A's node (`FlakyCallA`), never
  version B's (`FlakyCallB`), and `deployment_version_id` stayed pinned to A
  throughout.
- **Retry-count / max-retry boundary**: real 4-cycle exhaustion sequence
  (each cycle: 4 node-level attempts, real HTTP + real backoff) — observed
  `retry_count` sequence `[1, 2, 3]`, each exactly one more than the last,
  final state `status='failed'`, `next_run_at=null`. A subsequent dispatch
  call against the same (now-terminal) execution touches nothing.
- **Concurrency**: normal retry under the limit reserves-dispatches-releases
  correctly; a retry attempted while the user is at their limit reverts to
  `'waiting'` (not enqueued, not force-failed) and succeeds once the limit
  clears; re-reserving a previously-released `execution_id` (the Phase 8.8
  RPC fix) is genuinely active again and genuinely counts against the
  limit — proven by a follow-up reservation attempt correctly being
  refused.
- **Idempotency**: two concurrent "duplicate cron invocation" calls for the
  same retry attempt produce exactly one enqueued job between them.
- **Redis outage during enqueue**: the claimed execution reaches a real
  terminal `'failed'` state with a sanitized message
  (`"Retry dispatch queue unavailable. Please retry manually."`), bounded
  by the enqueue timeout rather than hanging, with its concurrency slot
  released — never left permanently claimed. A fresh execution dispatches
  normally once Redis is restarted.
- **Worker restart**: a resume job enqueued while no worker is running sits
  durably in Redis (execution row visibly still `'running'`/unconsumed);
  starting a brand-new worker instance consumes it and reaches `'success'`.
- **Self-heal interaction**: running `runSelfHeal()` against a legitimate
  `'waiting'` execution leaves it completely untouched; a simulated
  dispatcher crash (claimed into `'running'`, backdated past the staleness
  window) is correctly recovered by the *existing*
  `markOrphanExecutionsFailed` sweep — no new self-heal logic was needed.
- **Cron auth matrix**: missing `CRON_SECRET` env → 500 (fail closed);
  missing/wrong bearer → 401; valid bearer → 200 with aggregate counts only
  (`scanned`/`claimed`/`enqueued`/`skipped`/`failed`) — no execution IDs,
  user IDs, or error messages in the response.
- **Cross-tenant isolation**: two tenants each with a due waiting execution
  resolve independently in the same dispatch batch, no row cross-contamination,
  and saturating one tenant's concurrency limit never affects the other's.
- **Full live E2E**: real webhook trigger → real 4-attempt node-retry
  exhaustion → genuine `status='waiting'` → the real, auth-gated
  `/api/cron/dispatch-retries` route → dispatcher claims + enqueues through
  the real queue → real worker resumes → `status='success'` — with the full
  step history preserving *both* the original failed-attempt cycle and the
  distinctly-logged resumed cycle, and the concurrency reservation
  genuinely released at the end.

## Gate results

- TypeScript (`tsc --noEmit`): **0 errors**.
- Vitest full suite: **1433/1433 passing** (52 files), zero regressions
  from any Phase 8.8 change.
- `next build`: succeeds; `/api/cron/dispatch-retries` present in the
  build output.
- Security regression (SSRF, credential-injection allowlist,
  cross-tenant/IDOR, forged-webhook, cron-auth suites): all passing,
  unchanged.
- Disk stable throughout; unrelated Docker containers/networks verified
  untouched.

## Files changed

- `lib/runtime/retry-dispatcher.ts` — new. The dispatcher module.
- `app/api/cron/dispatch-retries/route.ts` — new. CRON_SECRET-gated entry point.
- `supabase/migrations/20260611000001_phase8_8_concurrency_reservation_reclaim.sql` — new. Fixes `reserve_concurrency_slot()`'s re-reservation bug.
- `lib/runtime/queue.ts` — added `'resume_workflow_execution'` to `RuntimeQueueTaskType`.
- `lib/runtime/worker.ts` — new `'resume_workflow_execution'` branch in `processRuntimeJob()`, mirroring the existing `'run_workflow_execution'` branch's deployment-version resolution, concurrency release, and fail-safe error handling.
- `lib/workflow-runtime/engine.ts` — new `resumeWorkflowExecution()` export, thinly wrapping the existing `ExecutionManager.resumeExecution()`.
- `vercel.json` — new cron entry, `/api/cron/dispatch-retries`, `* * * * *` (matching `dispatch-schedules`'s cadence).

## Remaining blockers

None for the core runtime. External provider validation for
Slack/Gmail/Airtable/Shopify remains pending from Phase 8.7 (no real
credential available in this environment) — unrelated to this phase's
scope.

## Final verdict

**PHASE 8.8: CORE RUNTIME FULLY CERTIFIED**

**DO NOT BEGIN PHASE 9.**
